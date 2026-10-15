const express = require('express');
const router = express.Router();
const database = require('./database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Jimp = require('jimp');
const runtimePaths = require('./config/paths');
const { runAiOmrScan, runAiOmrBenchmark, identifyLayout } = require('./services/ai-omr/aiOmrService');
const {
    loadAiOmrSettings,
    saveAiOmrSettings,
    publicAiOmrSettings
} = require('./services/ai-omr/settingsStore');
const { GeminiProvider } = require('./services/ai-omr/providers/geminiProvider');

runtimePaths.ensureRuntimeDirs();

const JWT_SECRET_FILE = runtimePaths.jwtSecretFile;
const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES_IN = '8h';

// Configure image storage
const IMAGE_CONFIG = {
    uploadDir: runtimePaths.uploadsImagesDir,
    thumbnailDir: runtimePaths.uploadsThumbnailsDir,
    maxFileSize: 5 * 1024 * 1024, // 5MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif']
};

const OMR_CALIBRATION_IMAGE_NAME = 'scan.jpg.png';
const OMR_CALIBRATION_IMAGE_PATH = path.join(runtimePaths.omrCalibrationInputDir, OMR_CALIBRATION_IMAGE_NAME);
const BACKUP_ARCHIVE_DIR = path.join(runtimePaths.repoRoot, '.runtime-backups');
const MAX_BACKUP_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB limit // No limit as requested
const MIN_BACKUP_SIZE_BYTES = 51200; // 50KB minimum — smaller files cannot be valid backups
const SCORING_INCOMPLETE_WARNING = 'Database answer key missing. Scoring incomplete.';

// Ensure upload directories exist
function ensureUploadDirs() {
    if (!fs.existsSync(IMAGE_CONFIG.uploadDir)) {
        fs.mkdirSync(IMAGE_CONFIG.uploadDir, { recursive: true });
    }
    if (!fs.existsSync(IMAGE_CONFIG.thumbnailDir)) {
        fs.mkdirSync(IMAGE_CONFIG.thumbnailDir, { recursive: true });
    }
}
ensureUploadDirs();

function expandUserPath(inputPath) {
    const raw = String(inputPath || '').trim();
    if (!raw) return '';
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    return raw;
}

function resolveCalibrationSourcePath(inputPath) {
    const expanded = expandUserPath(inputPath);
    if (!expanded) return '';
    if (path.isAbsolute(expanded)) return expanded;
    return path.resolve(runtimePaths.repoRoot, expanded);
}

function decodeImageDataUrl(imageData) {
    const matches = String(imageData || '').match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        throw new Error('Invalid image data payload');
    }
    return Buffer.from(matches[2], 'base64');
}

function createDebugArtifactName(prefix, extension) {
    const token = crypto.randomBytes(6).toString('hex');
    const safePrefix = String(prefix || 'debug').replace(/[^a-z0-9_-]+/gi, '_');
    const safeExtension = String(extension || 'jpg').replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'jpg';
    return `${safePrefix}_${Date.now()}_${token}.${safeExtension}`;
}

function readImagePayload(input) {
    const value = String(input || '').trim();
    if (!value) {
        throw new Error('Image data is required');
    }

    if (value.startsWith('data:image/')) {
        return decodeImageDataUrl(value);
    }

    const localPath = resolveStoredImageAbsolutePath(value);
    if (localPath && fs.existsSync(localPath)) {
        return fs.readFileSync(localPath);
    }

    throw new Error('Image data must be a base64 data URL or existing upload path');
}

function inferImageMimeType(input) {
    const value = String(input || '').trim();
    const dataUrlMatch = value.match(/^data:([A-Za-z-+\/]+);base64,/);
    if (dataUrlMatch) return dataUrlMatch[1];
    const extension = path.extname(value).replace('.', '').toLowerCase();
    if (extension === 'png') return 'image/png';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'gif') return 'image/gif';
    return 'image/jpeg';
}

function runFilledCircleDetector(imageBuffer, examId = null) {
    const workerPath = path.join(runtimePaths.pythonOmrDir, 'filled_circle_detector.py');
    if (!fs.existsSync(workerPath)) {
        return Promise.reject(new Error(`Filled-circle detector not found: ${workerPath}`));
    }

    if (!fs.existsSync(runtimePaths.uploadsDebugDir)) {
        fs.mkdirSync(runtimePaths.uploadsDebugDir, { recursive: true });
    }

    const debugName = createDebugArtifactName('bubble_debug', 'jpg');
    const thresholdName = createDebugArtifactName('bubble_threshold', 'png');
    const debugPath = path.join(runtimePaths.uploadsDebugDir, debugName);
    const thresholdPath = path.join(runtimePaths.uploadsDebugDir, thresholdName);
    const pythonCmd = getCalibrationPythonCommand();

    const args = [workerPath, '--stdin', '--debug-out', debugPath, '--threshold-out', thresholdPath];
    if (examId) {
        args.push('--exam-id', examId);
        args.push('--layout-dir', runtimePaths.omrLayoutsDir);
    }

    return new Promise((resolve, reject) => {
        const child = spawn(pythonCmd, args, {
                cwd: runtimePaths.repoRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            let parsed = null;
            try {
                parsed = stdout ? JSON.parse(stdout) : null;
            } catch (parseError) {
                if (code === 0) {
                    return reject(new Error(`Detector returned invalid JSON: ${parseError.message}`));
                }
            }

            if (code !== 0) {
                let detail = stderr.trim() || stdout.trim() || `Detector exited with code ${code}`;
                try {
                    const errorPayload = JSON.parse(detail);
                    detail = errorPayload.error || detail;
                } catch (_err) {
                    // Keep raw detector output.
                }
                return reject(new Error(detail));
            }

            const bubbles = Array.isArray(parsed?.bubbles) ? parsed.bubbles : [];
            return resolve({
                ...parsed,
                count: Number(parsed?.count) || bubbles.length,
                bubbles,
                debug_image_url: `/api/uploads/debug/${debugName}`,
                threshold_image_url: `/api/uploads/debug/${thresholdName}`
            });
        });

        child.stdin.end(imageBuffer);
    });
}

function safeLayoutExamId(value) {
    return String(value || '')
        .trim()
        .replace(/[^a-z0-9_.-]+/gi, '_')
        .slice(0, 120);
}

function getLayoutPathForExamId(examId) {
    const safeExamId = safeLayoutExamId(examId);
    if (!safeExamId) return null;
    return path.join(runtimePaths.omrLayoutsDir, `${safeExamId}.json`);
}

function normalizeGeneratedLayoutPayload(payload = {}) {
    const layout = payload.layout && typeof payload.layout === 'object' ? payload.layout : payload;
    const examId = String(
        layout.examId
        || layout.exam_id
        || payload.examId
        || payload.exam_id
        || ''
    ).trim();
    if (!examId) {
        throw new Error('layout examId/exam_id is required');
    }

    const sheetSize = layout.sheetSize || layout.sheet_size || {};
    const width = Number(sheetSize.width);
    const height = Number(sheetSize.height);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        throw new Error('layout.sheetSize.width and layout.sheetSize.height are required');
    }

    return {
        ...layout,
        layoutVersion: String(layout.layoutVersion || layout.layout_version || 'generated-layout-v1'),
        examId,
        exam_id: examId,
        sheetSize: { width, height },
        savedAt: new Date().toISOString()
    };
}

function getOmrExamId(omrResult = {}) {
    const barcodeData = omrResult.barcodeData && typeof omrResult.barcodeData === 'object' ? omrResult.barcodeData : {};
    const templateMetrics = omrResult.templateMetrics && typeof omrResult.templateMetrics === 'object' ? omrResult.templateMetrics : {};
    return String(
        barcodeData.examId
        || barcodeData.exam_id
        || omrResult.examId
        || omrResult.exam_id
        || templateMetrics.examId
        || templateMetrics.exam_id
        || ''
    ).trim();
}

function appendUniqueWarning(omrResult, warning) {
    const warnings = Array.isArray(omrResult?.warnings) ? [...omrResult.warnings] : [];
    if (warning && !warnings.includes(warning)) warnings.push(warning);
    return warnings;
}

function markGeneratedLayoutResult(omrResult = {}) {
    const examId = getOmrExamId(omrResult);
    return {
        ...omrResult,
        examId,
        scanMode: 'generated_layout',
        layoutFound: true,
        layoutId: examId || null,
        workerUsed: 'layout_worker',
        warnings: Array.isArray(omrResult.warnings) ? omrResult.warnings : [],
        needsReview: Boolean(omrResult.needsReview)
    };
}

function buildGeneratedLayoutFailureResponse(omrResult = {}) {
    const examId = getOmrExamId(omrResult);
    return {
        success: false,
        scanMode: 'generated_layout',
        workerUsed: 'layout_worker',
        layoutFound: false,
        layoutId: omrResult.layoutId || examId || null,
        examId: examId || null,
        barcodeData: omrResult.barcodeData || {},
        barcodeStatus: omrResult.barcodeStatus || 'failed',
        warnings: Array.isArray(omrResult.warnings) ? omrResult.warnings : [],
        requiresLayout: Boolean(omrResult.requiresLayout),
        error: omrResult.error || 'Generated layout scan failed.'
    };
}

function getGeneratedLayoutFailureStatus(omrResult = {}) {
    if (omrResult.requiresLayout) return 404;
    return 422;
}

function buildScanResponseMetadata(omrResult = {}, scoringStatus = null) {
    const warnings = Array.isArray(omrResult.warnings) ? omrResult.warnings : [];
    const examId = getOmrExamId(omrResult);
    return {
        scanMode: 'generated_layout',
        layoutFound: Boolean(omrResult.layoutFound),
        layoutId: omrResult.layoutId || examId || null,
        examId: examId || null,
        workerUsed: 'layout_worker',
        layoutBubbleCount: Number(omrResult.layoutBubbleCount ?? omrResult.templateMetrics?.layoutBubbleCount ?? 0),
        evaluatedBubbleCount: Number(omrResult.evaluatedBubbleCount ?? omrResult.templateMetrics?.evaluatedBubbleCount ?? 0),
        detectedAnswerCount: Number(omrResult.detectedAnswerCount ?? omrResult.templateMetrics?.detectedAnswerCount ?? 0),
        detectedBubbleCount: Number(omrResult.detectedBubbleCount ?? omrResult.templateMetrics?.detectedBubbleCount ?? 0),
        mappedBubbleCount: Number(omrResult.mappedBubbleCount ?? omrResult.templateMetrics?.mappedBubbleCount ?? 0),
        mappingConfidence: Number(omrResult.mappingConfidence ?? omrResult.templateMetrics?.mappingConfidence ?? 0),
        needsReview: Boolean(omrResult.needsReview),
        reviewStatus: omrResult.reviewStatus || null,
        warnings,
        debugImagePath: omrResult.debugImagePath || null,
        barcodeData: omrResult.barcodeData || {},
        entryGroup: omrResult.entryGroup || null,
        equityGroup: omrResult.equityGroupResult || omrResult.equityGroup || null,
        scoringStatus: scoringStatus || omrResult.scoringStatus || null
    };
}

function runGeneratedLayoutOmr(imageBuffer, options = {}) {
    const workerPath = path.join(runtimePaths.pythonOmrDir, 'layout_worker.py');
    if (!fs.existsSync(workerPath)) {
        return Promise.reject(new Error(`Generated-layout OMR worker not found: ${workerPath}`));
    }
    if (!fs.existsSync(runtimePaths.uploadsDebugDir)) {
        fs.mkdirSync(runtimePaths.uploadsDebugDir, { recursive: true });
    }
    if (!fs.existsSync(runtimePaths.omrLayoutsDir)) {
        fs.mkdirSync(runtimePaths.omrLayoutsDir, { recursive: true });
    }

    const pythonCmd = getCalibrationPythonCommand();
    const workerOptions = {
        layoutsDir: runtimePaths.omrLayoutsDir,
        debugDir: runtimePaths.uploadsDebugDir,
        rotation: Number(options.rotation) || 0,
        debug: options.debug !== false,
        threshold: Number(options.threshold) || 0.38,
        requestId: String(options.requestId || ''),
        debugProblemQuestions: Boolean(options.debugProblemQuestions),
        debugRatios: Boolean(options.debugRatios),
        forensicDebug: Boolean(options.forensicDebug),
        scanId: options.scanId || undefined,
        scanFile: options.scanFile || undefined
    };

    return new Promise((resolve, reject) => {
        const child = spawn(
            pythonCmd,
            [workerPath, '--stdin', JSON.stringify(workerOptions)],
            {
                cwd: runtimePaths.repoRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(stderr.trim() || stdout.trim() || `Generated-layout OMR worker exited with code ${code}`));
            }
            try {
                const parsed = JSON.parse(stdout || '{}');
                const stderrText = stderr.trim();
                if (stderrText) {
                    console.log(`[layout_worker] ${stderrText}`);
                }
                console.log(
                    `[layout_worker] scanMode=${parsed.scanMode || 'generated_layout'} layoutId=${parsed.layoutId || getOmrExamId(parsed) || '-'} ` +
                    `layoutBubbleCount=${parsed.layoutBubbleCount ?? parsed.templateMetrics?.layoutBubbleCount ?? '-'} ` +
                    `evaluatedBubbleCount=${parsed.evaluatedBubbleCount ?? parsed.templateMetrics?.evaluatedBubbleCount ?? '-'} ` +
                    `detectedAnswerCount=${parsed.detectedAnswerCount ?? parsed.templateMetrics?.detectedAnswerCount ?? '-'}`
                );
                resolve(parsed);
            } catch (error) {
                reject(new Error(`Generated-layout OMR worker returned invalid JSON: ${error.message}`));
            }
        });
        child.stdin.end(imageBuffer);
    });
}

function sanitizeReceivedPaperFileName(input, extension) {
    const fallbackExt = String(extension || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
    const raw = String(input || '').trim();
    const baseName = raw
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[^a-z0-9_-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return `${baseName || `paper_${Date.now()}`}.${fallbackExt}`;
}

function getCalibrationPythonCommand() {
    const envPython = String(process.env.SCANCHECK_PYTHON || '').trim();
    if (envPython && isUsablePythonCommand(envPython)) return envPython;

    const localCandidates = [
        path.join(runtimePaths.repoRoot, '.venv', 'bin', 'python'),
        path.join(runtimePaths.repoRoot, '.venv', 'Scripts', 'python.exe')
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

function ensureCalibrationInputDir() {
    if (!fs.existsSync(runtimePaths.omrCalibrationInputDir)) {
        fs.mkdirSync(runtimePaths.omrCalibrationInputDir, { recursive: true });
    }
}

function splitCommandLine(input) {
    const text = String(input || '').trim();
    if (!text) return [];
    const parts = [];
    const re = /[^\s"]+|"([^"]*)"/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        parts.push(match[1] != null ? match[1] : match[0]);
    }
    return parts;
}

function resolveRecalibrationConfigPath(targetKey) {
    const key = String(targetKey || 'runtime-template').trim().toLowerCase();
    switch (key) {
        case 'runtime-template':
            return path.join(runtimePaths.omrCalibrationInputDir, 'template.json');
        case 'runtime-config':
            return path.join(runtimePaths.omrCalibrationInputDir, 'config.json');
        case 'runtime-reference-image':
            return OMR_CALIBRATION_IMAGE_PATH;
        case 'repo-template':
            return path.join(runtimePaths.omrTemplateDir, 'template.json');
        case 'repo-config':
            return path.join(runtimePaths.omrTemplateDir, 'config.json');
        default:
            throw new Error(`Unknown config target: ${targetKey}`);
    }
}

function getDefaultEditorCommand() {
    if (process.platform === 'win32') return 'code';
    return 'code';
}

function shellEscapeSingle(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function commandExists(commandName) {
    if (!commandName) return false;
    if (process.platform === 'win32') {
        try {
            const { status } = spawnSync('where', [commandName], { stdio: 'ignore' });
            return status === 0;
        } catch (_e) {
            return true; // Fallback to original behavior
        }
    }
    const result = spawnSync('which', [commandName], {
        stdio: 'ignore'
    });
    return result.status === 0;
}

function findTerminalEmulator() {
    const preferred = String(process.env.SCANCHECK_TERMINAL || '').trim();
    if (preferred && commandExists(preferred)) return preferred;
    const candidates = [
        'alacritty',
        'kitty',
        'gnome-terminal',
        'konsole',
        'xfce4-terminal',
        'x-terminal-emulator',
        'xterm'
    ];
    return candidates.find((candidate) => commandExists(candidate)) || '';
}

function buildEditorLaunchCommand(editorCommand, filePath) {
    const commandText = String(editorCommand || '').trim() || getDefaultEditorCommand();
    const parts = splitCommandLine(commandText);
    if (parts.length === 0) {
        throw new Error('Editor command is empty.');
    }

    const editorBin = parts[0];
    const editorArgs = parts.slice(1);
    const terminalEditors = new Set(['nvim', 'vim', 'vi', 'nano']);
    const isTerminalEditor = terminalEditors.has(editorBin.toLowerCase());

    if (process.platform === 'win32') {
        if (isTerminalEditor) {
            const quotedFile = `"${filePath.replace(/"/g, '\\"')}"`;
            const openCmd = `${commandText} ${quotedFile}`;
            return {
                command: 'cmd',
                args: ['/c', 'start', 'cmd', '/k', openCmd]
            };
        }
        return { command: editorBin, args: [...editorArgs, filePath] };
    }

    if (isTerminalEditor) {
        const terminal = findTerminalEmulator();
        if (!terminal) {
            throw new Error('No terminal emulator found for nvim/vim. Install one or use a GUI editor command like "code".');
        }

        const shellCmd = [editorBin, ...editorArgs, shellEscapeSingle(filePath)].join(' ');

        if (terminal === 'gnome-terminal') {
            return {
                command: terminal,
                args: ['--', 'sh', '-lc', shellCmd]
            };
        }

        if (terminal === 'xfce4-terminal') {
            return {
                command: terminal,
                args: ['--command', shellCmd]
            };
        }

        if (terminal === 'alacritty' || terminal === 'kitty' || terminal === 'xterm' || terminal === 'konsole' || terminal === 'x-terminal-emulator') {
            return {
                command: terminal,
                args: ['-e', 'sh', '-lc', shellCmd]
            };
        }

        return {
            command: terminal,
            args: ['-e', editorBin, ...editorArgs, filePath]
        };
    }

    return {
        command: editorBin,
        args: [...editorArgs, filePath]
    };
}

function launchDetachedWithProbe(command, args, cwd) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let child = null;

        try {
            child = spawn(command, args, {
                cwd,
                detached: true,
                stdio: 'ignore',
                shell: false
            });
        } catch (error) {
            reject(error);
            return;
        }

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                child.unref();
            } catch (_) {
                // ignore
            }
            resolve({ pid: child.pid });
        }, 600);

        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });

        child.once('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0) {
                resolve({ pid: child.pid });
                return;
            }
            reject(new Error(`Editor launch exited early (code: ${code ?? 'unknown'}${signal ? `, signal: ${signal}` : ''}).`));
        });
    });
}

function setCalibrationReferenceImage({ imagePath, imageData }) {
    ensureCalibrationInputDir();
    let buffer = null;
    let sourcePath = '';

    if (String(imageData || '').trim()) {
        buffer = decodeImageDataUrl(imageData);
        sourcePath = '[uploaded-image]';
    } else {
        const resolvedPath = resolveCalibrationSourcePath(imagePath);
        if (!resolvedPath) {
            throw new Error('Image path is required');
        }
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`Reference image not found: ${resolvedPath}`);
        }
        const stat = fs.statSync(resolvedPath);
        if (!stat.isFile()) {
            throw new Error(`Reference image path is not a file: ${resolvedPath}`);
        }
        buffer = fs.readFileSync(resolvedPath);
        sourcePath = resolvedPath;
    }

    fs.writeFileSync(OMR_CALIBRATION_IMAGE_PATH, buffer);
    return {
        sourcePath,
        destinationPath: OMR_CALIBRATION_IMAGE_PATH,
        bytes: buffer.length
    };
}

function ensureBackupArchiveDir() {
    if (!fs.existsSync(BACKUP_ARCHIVE_DIR)) {
        fs.mkdirSync(BACKUP_ARCHIVE_DIR, { recursive: true });
    }
}

function buildBackupStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

function runProcessSync(command, args, options = {}) {
    try {
        const result = spawnSync(command, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            ...options
        });

        if (result.error) {
            throw new Error(`${command} failed to start: ${result.error.message}`);
        }

        if (result.status !== 0) {
            const stderr = String(result.stderr || '').trim();
            const stdout = String(result.stdout || '').trim();
            throw new Error(stderr || stdout || `${command} exited with code ${result.status}`);
        }
    } catch (error) {
        console.error(`[Process Error] ${command} ${args.join(' ')}:`, error.message);
        throw error;
    }
}

function createZipArchive(sourceDir, destinationZipPath) {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Backup source does not exist: ${sourceDir}`);
    }

    if (process.platform === 'win32') {
        // Use .NET System.IO.Compression.ZipFile via PowerShell (most reliable on Windows)
        try {
            const escapedSource = sourceDir.replace(/'/g, "''");
            const escapedDest = destinationZipPath.replace(/'/g, "''");
            const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${escapedSource}', '${escapedDest}', 'Optimal', $false)`;
            runProcessSync('powershell', ['-NoProfile', '-Command', script]);
            if (fs.existsSync(destinationZipPath)) return;
        } catch (dotnetError) {
            console.warn(`[Backup] .NET ZipFile failed, trying tar.exe: ${dotnetError.message}`);
        }

        // Fallback to tar.exe (available on Windows 10+)
        try {
            runProcessSync('tar.exe', ['-a', '-c', '-f', destinationZipPath, '-C', sourceDir, '.']);
            if (fs.existsSync(destinationZipPath)) return;
        } catch (tarError) {
            console.warn(`[Backup] tar.exe failed, falling back to PowerShell Compress-Archive: ${tarError.message}`);
        }

        // Final fallback to PowerShell Compress-Archive
        const script = `Compress-Archive -Path '${path.join(sourceDir, "*").replace(/'/g, "''")}' -DestinationPath '${destinationZipPath.replace(/'/g, "''")}' -Force`;
        runProcessSync('powershell', ['-NoProfile', '-Command', script]);
        if (!fs.existsSync(destinationZipPath)) {
            throw new Error(`ZIP archive was not created at: ${destinationZipPath}`);
        }
        return;
    }

    runProcessSync('zip', ['-r', '-q', destinationZipPath, '.'], { cwd: sourceDir });
    if (!fs.existsSync(destinationZipPath)) {
        throw new Error(`ZIP archive was not created at: ${destinationZipPath}`);
    }
}

function extractZipArchive(zipPath, destinationDir) {
    if (!fs.existsSync(zipPath)) {
        throw new Error(`Backup file not found: ${zipPath}`);
    }
    if (!fs.existsSync(destinationDir)) {
        fs.mkdirSync(destinationDir, { recursive: true });
    }

    if (process.platform === 'win32') {
        const script = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`;
        runProcessSync('powershell', ['-NoProfile', '-Command', script]);
    } else {
        runProcessSync('unzip', ['-q', zipPath, '-d', destinationDir]);
    }

    // Remove any extracted logs directory (avoid file locks on Windows)
    function removeLogsDir(baseDir) {
        const logsPath = path.join(baseDir, 'logs');
        if (fs.existsSync(logsPath)) {
            try {
                safeRm(logsPath);
            } catch (e) {
                // Ignore errors if we can't delete it
            }
        }
        // Also check subdirectories for logs dir (in case backup has runtime as subdir)
        if (fs.existsSync(baseDir)) {
            for (const entry of fs.readdirSync(baseDir)) {
                const entryPath = path.join(baseDir, entry);
                if (fs.statSync(entryPath).isDirectory()) {
                    removeLogsDir(entryPath);
                }
            }
        }
    }
    removeLogsDir(destinationDir);

    // Validate extraction produced output
    if (!fs.existsSync(destinationDir) || fs.readdirSync(destinationDir).length === 0) {
        throw new Error(`Extraction produced no files in ${destinationDir}`);
    }
}

async function createRuntimeBackupArchive(destinationZipPath) {
    const stagingDir = path.join(os.tmpdir(), `scancheck-backup-staging-${Date.now()}`);
    
    try {
        fs.mkdirSync(stagingDir, { recursive: true });
        
        // Copy everything from runtimeRoot to staging, excluding tools and tmp
        if (fs.existsSync(runtimePaths.runtimeRoot)) {
            const entries = fs.readdirSync(runtimePaths.runtimeRoot);
            for (const entry of entries) {
                // Exclude bulky and volatile directories/files
                if (['tools', 'tmp', 'logs', 'scancheck.pid', 'current_port.txt'].includes(entry)) continue;
                
                const src = path.join(runtimePaths.runtimeRoot, entry);
                const dst = path.join(stagingDir, entry);
                
                if (entry === 'data') {
                    // Special handling for data dir to backup DB safely
                    fs.mkdirSync(dst, { recursive: true });
                    
                    // Copy data directory excluding live DB files
                    fs.cpSync(src, dst, { 
                        recursive: true, 
                        filter: (srcPath) => {
                            const name = path.basename(srcPath);
                            // Skip live DB files and its sidecars
                            if (name === 'scancheck.db' || 
                                name.startsWith('scancheck.db-') || 
                                name === '.jwt_secret') return false;
                            return true;
                        }
                    });
                    
                    // Safely backup the database using SQLite's VACUUM INTO
                    await database.backup(path.join(dst, 'scancheck.db'));
                    
                    // Copy JWT secret if it exists
                    if (fs.existsSync(runtimePaths.jwtSecretFile)) {
                        fs.copyFileSync(runtimePaths.jwtSecretFile, path.join(dst, '.jwt_secret'));
                    }
                } else {
                    fs.cpSync(src, dst, { recursive: true });
                }
            }
        }
        
        createZipArchive(stagingDir, destinationZipPath);
        return destinationZipPath;
    } finally {
        if (fs.existsSync(stagingDir)) {
            try {
                fs.rmSync(stagingDir, { recursive: true, force: true });
            } catch (_e) { /* ignore cleanup errors */ }
        }
    }
}

function listRuntimeBackupArchives() {
    ensureBackupArchiveDir();
    return fs.readdirSync(BACKUP_ARCHIVE_DIR)
        .filter((fileName) => fileName.toLowerCase().endsWith('.zip'))
        .map((fileName) => {
            const absolutePath = path.join(BACKUP_ARCHIVE_DIR, fileName);
            const stat = fs.statSync(absolutePath);
            return {
                fileName,
                absolutePath,
                sizeBytes: stat.size,
                modifiedAt: stat.mtime.toISOString()
            };
        })
        .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
}

function streamRequestToFile(req, destinationPath, maxBytes = MAX_BACKUP_UPLOAD_BYTES) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destinationPath);
        let totalBytes = 0;

        req.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                fileStream.destroy();
                fs.unlinkSync(destinationPath);
                reject(new Error(`Upload exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`));
                req.destroy();
                return;
            }
            if (!fileStream.write(chunk)) {
                req.pause();
                fileStream.once('drain', () => req.resume());
            }
        });

        req.on('end', () => {
            fileStream.end();
        });

        fileStream.on('finish', () => resolve(totalBytes));
        fileStream.on('error', (err) => {
            fs.unlinkSync(destinationPath);
            reject(err);
        });
        req.on('error', (err) => {
            fileStream.destroy();
            fs.unlinkSync(destinationPath);
            reject(err);
        });
    });
}

function readRequestBuffer(req, maxBytes = MAX_BACKUP_UPLOAD_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        req.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                reject(new Error(`Upload exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function looksLikeRuntimeDir(dirPath) {
    const requiredMarkers = ['data', 'omr-calib'];
    return requiredMarkers.some((marker) => fs.existsSync(path.join(dirPath, marker)));
}

function resolveRestoredRuntimeDir(extractRootDir) {
    const directCandidate = path.join(extractRootDir, path.basename(runtimePaths.runtimeRoot));
    if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isDirectory() && looksLikeRuntimeDir(directCandidate)) {
        return directCandidate;
    }

    if (looksLikeRuntimeDir(extractRootDir)) {
        return extractRootDir;
    }

    const directoryChildren = fs.readdirSync(extractRootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(extractRootDir, entry.name));
    if (directoryChildren.length === 1 && looksLikeRuntimeDir(directoryChildren[0])) {
        return directoryChildren[0];
    }

    return '';
}

function clearDirectoryContents(dirPath, exclude = []) {
    if (!fs.existsSync(dirPath)) return;
    let entries = [];
    try {
        entries = fs.readdirSync(dirPath);
    } catch (err) {
        console.warn(`[Warning] Could not read directory ${dirPath}:`, err.message);
        return;
    }

    for (const child of entries) {
        if (exclude.includes(child) || child === 'logs' || child === 'tmp') continue;
        const fullPath = path.join(dirPath, child);
        try {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (err) {
            console.warn(`[Warning] Failed to remove ${fullPath}, skipping and continuing...`, err.message);
            // On Windows, try PowerShell as a last resort, but if that fails too, just ignore it
            if (process.platform === 'win32') {
                try {
                    spawnSync('powershell', ['-NoProfile', '-Command', `Remove-Item -Recurse -Force '${fullPath.replace(/'/g, "''")}'`], { stdio: 'ignore' });
                } catch (psErr) {
                    // Just ignore
                }
            }
        }
    }
}

function safeCopyDirectory(src, dest, exclude = []) {
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
        if (exclude.includes(entry) || entry === 'logs' || entry === 'tmp') continue;
        
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        
        if (fs.statSync(srcPath).isDirectory()) {
            safeCopyDirectory(srcPath, destPath, exclude);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function getJwtSecret() {
    const configuredSecret = String(process.env.SCANCHECK_JWT_SECRET || '').trim();
    if (configuredSecret) {
        return configuredSecret;
    }

    try {
        if (fs.existsSync(JWT_SECRET_FILE)) {
            return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
        }

        const generated = crypto.randomBytes(48).toString('hex');
        fs.writeFileSync(JWT_SECRET_FILE, `${generated}\n`, 'utf8');
        return generated;
    } catch (error) {
        throw new Error(`Unable to initialize JWT secret: ${error.message}`);
    }
}

function normalizeSheetFormat(value) {
    // Normal mode is retired; scanner pipeline uses multi-subject templates only.
    return 'multi-subject';
}

function generateShortOcrPaperId() {
    return `OCR-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function getExpectedTemplateType(questionCount, sheetFormat) {
    if (Number(questionCount) === 100) return 'multi_subject';
    return 'multi_subject_custom';
}

function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const current = points[i];
        const next = points[(i + 1) % points.length];
        area += (Number(current?.x) || 0) * (Number(next?.y) || 0);
        area -= (Number(next?.x) || 0) * (Number(current?.y) || 0);
    }
    return Math.abs(area) / 2;
}

function validateDetectedSheet(omrResult, questionCount, sheetFormat) {
    const expectedTemplateType = getExpectedTemplateType(questionCount, sheetFormat);
    const alignmentConfidence = Number(omrResult?.alignmentConfidence || 0);
    const templateConfidence = Number(omrResult?.templateConfidence || 0);
    const overallConfidence = Number(omrResult?.overallConfidence || 0);
    const alignmentMode = String(omrResult?.alignmentMode || '');
    const contentQuad = Array.isArray(omrResult?.contentQuad) ? omrResult.contentQuad : null;
    const templateMetrics = omrResult?.templateMetrics || {};
    const answers = Array.isArray(omrResult?.answers) ? omrResult.answers : [];
    const questionMetrics = Array.isArray(omrResult?.questionMetrics) ? omrResult.questionMetrics : [];
    const activeMetrics = questionMetrics.filter((metric) => String(metric?.state || '').trim().toLowerCase() !== 'ignored');
    const answeredCount = answers.filter((answer) => String(answer || '').trim().length > 0).length;
    const detectedCount = activeMetrics.filter((metric) => String(metric?.state || '').trim().toLowerCase() === 'detected').length;
    const reviewCount = activeMetrics.filter((metric) => metric && metric.state === 'review').length;
    const ambiguousCount = activeMetrics.filter((metric) => {
        const raw = String(metric?.rawAnswer || '').trim().toUpperCase();
        return /^[A-E]{2,}$/.test(raw);
    }).length;
    const reviewRatio = activeMetrics.length > 0 ? (reviewCount / activeMetrics.length) : 0;
    const ambiguousRatio = activeMetrics.length > 0 ? (ambiguousCount / activeMetrics.length) : 0;
    const topRightCircles = Number(templateMetrics.topRightCircles || 0);
    const headerBandCircles = Number(templateMetrics.headerBandCircles || 0);
    const quadArea = polygonArea(contentQuad);
    
    // Robust validation flags for generated-layout scans.
    const hasAnyContent = answeredCount > 0 || (activeMetrics.length > 0 && reviewRatio < 0.95);
    const weakBoundary = !contentQuad || contentQuad.length !== 4 || quadArea < 100000;
    const weakAlignment = alignmentConfidence < 0.60;
    
    const warnings = [];

    const generatedLayoutScan = String(omrResult?.omrEngineUsed || '').trim() === 'generated-layout'
        || String(omrResult?.templateType || '').trim() === 'generated_layout';

    // Generated-layout scans may be valid with blank answers.
    if (answeredCount === 0 && !generatedLayoutScan) {
        return {
            valid: false,
            error: 'Empty answer sheet rejected.',
            details: 'No shaded bubbles were detected. Shade at least one answer before scanning.'
        };
    }

    const severeBubbleMisalignment = (
        detectedCount >= 10 &&
        ambiguousCount >= Math.max(8, Math.ceil(activeMetrics.length * 0.08)) &&
        ambiguousRatio >= 0.08
    );
    if (severeBubbleMisalignment) {
        return {
            valid: false,
            error: 'Answer bubbles are not aligned with the scanner template.',
            details: `Detected ${ambiguousCount} ambiguous/multi-mark reads out of ${activeMetrics.length} active questions. Re-align the paper and scan again.`
        };
    }

    // Instead of immediate rejection, we collect warnings
    if (weakBoundary) {
        warnings.push("Paper boundary detection is weak. Alignment may be less accurate.");
    }
    if (weakAlignment) {
        warnings.push(`Low alignment confidence (${Math.round(alignmentConfidence * 100)}%). Result might be inaccurate.`);
    }
    if (templateConfidence < 0.65) {
        warnings.push("Template type could not be confidently determined.");
    }
    if (answeredCount === 0 && generatedLayoutScan) {
        warnings.push("No answer bubbles were shaded; generated layout was still processed.");
    }
    if (reviewRatio > 0.35) {
        warnings.push(`High number of uncertain answers (${reviewCount}/${activeMetrics.length}). Manual review recommended.`);
    }

    // Template mismatch is now a warning instead of rejection
    if (expectedTemplateType && omrResult?.templateType && omrResult.templateType !== expectedTemplateType) {
        warnings.push(`Expected ${expectedTemplateType} but detected ${omrResult.templateType}.`);
    }

    // Only reject if there's absolutely no usable content or confidence is extremely low
    if (!hasAnyContent && overallConfidence < 0.20) {
        return {
            valid: false,
            error: 'The uploaded image does not contain a readable answer sheet.',
            details: 'No answers or paper structure could be detected even with fallback processing.'
        };
    }

    return { 
        valid: true, 
        warning: warnings.length > 0 ? warnings.join(' ') : null,
        needsReview: warnings.length > 0 || overallConfidence < 0.60 || reviewRatio > 0.25
    };
}

function cleanExtractedField(value, mode = 'generic') {
    let text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    if (mode === 'name') {
        text = text.replace(/[^A-Za-z.\-'\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length < 4) return '';
        const alphaCount = (text.match(/[A-Za-z]/g) || []).length;
        if (alphaCount < 4) return '';
        return text;
    }

    if (mode === 'course') {
        text = text.replace(/[^A-Za-z0-9&().,\-\/\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (text.length < 3) return '';
        return text;
    }

    return text;
}

function normalizeStatusValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized === 'pass' || normalized === 'passinhon') return 'PASS';
    if (normalized === 'fail' || normalized === 'non-passinhon' || normalized === 'non passinhon') return 'FAIL';
    return String(value || '').trim().toUpperCase();
}

function isPassingStatus(value) {
    return normalizeStatusValue(value) === 'PASS';
}

function expandStatusFilterValues(value) {
    const normalized = normalizeStatusValue(value);
    if (normalized === 'PASS') return ['PASS', 'Passinhon'];
    if (normalized === 'FAIL') return ['FAIL', 'Non-Passinhon'];
    return [String(value || '').trim()].filter(Boolean);
}

const DEFAULT_SUBJECT_CONFIG = [
    { code: 'ENG', name: 'ENGLISH', questions: 20 },
    { code: 'SCI', name: 'SCIENCE', questions: 20 },
    { code: 'MATH', name: 'MATHEMATICS', questions: 20 },
    { code: 'GEN', name: 'GENERAL KNOWLEDGE', questions: 20 },
    { code: 'ABS', name: 'ABSTRACT REASONING', questions: 20 }
];

function parseSubjectConfigValue(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
        return null;
    }
}

function normalizeStoredSubjectConfig(rawSubjects, { allowZero = true } = {}) {
    const source = Array.isArray(rawSubjects) && rawSubjects.length > 0
        ? rawSubjects
        : DEFAULT_SUBJECT_CONFIG;
    const minQuestions = allowZero ? 0 : 1;
    return source
        .slice(0, 5)
        .map((item, index) => {
            const fallback = DEFAULT_SUBJECT_CONFIG[index] || {};
            const code = String(item?.code || fallback.code || `SUB${index + 1}`).trim().toUpperCase();
            const name = String(item?.name || fallback.name || code).trim().toUpperCase();
            const parsedQuestions = Number.parseInt(String(item?.questions ?? fallback.questions ?? 20), 10);
            const questions = Number.isFinite(parsedQuestions)
                ? Math.max(minQuestions, Math.min(100, parsedQuestions))
                : (fallback.questions || 20);
            return { code, name, questions };
        })
        .filter((item) => item.code && item.name);
}

function normalizeSingleSubjectConfig(rawSubjects, title = '', questionCount = 100) {
    const first = Array.isArray(rawSubjects) && rawSubjects.length > 0 ? rawSubjects[0] : {};
    const rawTitle = String(title || '').trim();
    const fallbackName = rawTitle || 'EXAM QUESTIONS';
    const fallbackCode = fallbackName
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .split(/\s+/)
        .map((part) => part.charAt(0))
        .join('')
        .slice(0, 8)
        .toUpperCase() || 'EXAM';
    const parsedQuestions = Number.parseInt(String(first?.questions ?? questionCount ?? 100), 10);
    return [{
        code: String(first?.code || fallbackCode).trim().toUpperCase(),
        name: String(first?.name || fallbackName).trim().toUpperCase(),
        questions: Number.isFinite(parsedQuestions) ? Math.min(100, Math.max(1, parsedQuestions)) : 100
    }];
}

function normalizeQuizSubjectConfig(format, rawSubjects, title = '', questionCount = 100) {
    if (format === 'normal') {
        return normalizeSingleSubjectConfig(rawSubjects, title, questionCount);
    }
    return normalizeStoredSubjectConfig(rawSubjects);
}

function normalizeQuizPayload(payload = {}) {
    const format = (payload.format === 'normal') ? 'normal' : 'multi-subject';
    const parsedQuestionCount = Number.parseInt(String(payload.questionCount || payload.question_count || 0), 10);
    const title = String(payload.title || '').trim();
    const rawSubjectConfig = payload.subjectConfig ?? payload.subject_config ?? payload.subjects;
    const options = Number.isFinite(Number(payload.options)) ? Math.min(6, Math.max(4, Number(payload.options))) : 4;

    const normalized = {
        title,
        format,
        options,
        questionCount: Number.isFinite(parsedQuestionCount)
            ? Math.min(100, Math.max(1, parsedQuestionCount))
            : 100,
        subjectConfig: []
    };
    normalized.subjectConfig = normalizeQuizSubjectConfig(
        format,
        parseSubjectConfigValue(rawSubjectConfig) || rawSubjectConfig,
        title,
        normalized.questionCount
    );
    return normalized;
}

function normalizeSubjectQuestionConfig(rawSubjects) {
    if (!Array.isArray(rawSubjects)) return [];
    return normalizeStoredSubjectConfig(rawSubjects)
        .map((item) => ({
            code: item.code,
            questions: Number(item.questions) || 0
        }));
}

function buildActiveQuestionNumbers(totalQuestions, requestedCount, rawSubjects) {
    const total = Math.max(1, Math.min(100, Number.parseInt(String(totalQuestions || 0), 10) || 100));
    const requested = Math.max(1, Math.min(total, Number.parseInt(String(requestedCount || 0), 10) || total));
    const subjects = normalizeSubjectQuestionConfig(rawSubjects);

    if (subjects.length >= 5) {
        const blockSize = Math.floor(total / subjects.length);
        const active = [];
        for (let i = 0; i < subjects.length; i++) {
            const blockStart = (i * blockSize) + 1;
            const maxInBlock = Math.max(0, blockSize);
            const wanted = Math.max(0, Math.min(maxInBlock, Number(subjects[i].questions) || 0));
            for (let offset = 0; offset < wanted; offset++) {
                active.push(blockStart + offset);
            }
        }
        if (active.length > 0) {
            return active.filter((qNum) => qNum >= 1 && qNum <= total);
        }
    }

    const fallback = [];
    for (let i = 1; i <= requested; i++) fallback.push(i);
    return fallback;
}

function applyActiveMaskToOmrResult(omrResult, activeQuestionNumbers, totalQuestions) {
    const sourceAnswers = Array.isArray(omrResult?.answers) ? omrResult.answers : [];
    const sourceMetrics = Array.isArray(omrResult?.questionMetrics) ? omrResult.questionMetrics : [];
    const sourceConfidence = (omrResult && typeof omrResult.confidence === 'object' && omrResult.confidence) ? omrResult.confidence : {};
    const metricByQuestion = new Map(
        sourceMetrics
            .map((metric) => [Number(metric?.questionNumber ?? metric?.question), metric])
            .filter(([qNum]) => Number.isFinite(qNum) && qNum > 0)
    );

    const total = Math.max(
        1,
        Number.parseInt(String(totalQuestions || 0), 10) || sourceAnswers.length || sourceMetrics.length || 100
    );
    const activeSet = new Set(
        (Array.isArray(activeQuestionNumbers) ? activeQuestionNumbers : [])
            .map((value) => Number.parseInt(String(value), 10))
            .filter((value) => Number.isFinite(value) && value >= 1 && value <= total)
    );
    if (activeSet.size === 0) {
        for (let qNum = 1; qNum <= total; qNum++) activeSet.add(qNum);
    }

    const maskedAnswers = [];
    const maskedMetrics = [];
    const maskedConfidence = {};
    const activeQuestionList = Array.from(activeSet).sort((a, b) => a - b);
    let activeOrdinal = 0;

    for (let qNum = 1; qNum <= total; qNum++) {
        const srcMetric = metricByQuestion.get(qNum) || {};
        const isActive = activeSet.has(qNum);
        const answerRaw = isActive ? String(sourceAnswers[qNum - 1] || '').trim().toUpperCase() : '';
        if (isActive) activeOrdinal += 1;

        const metric = {
            ...srcMetric,
            questionNumber: qNum,
            originalQuestionNumber: qNum,
            displayQuestionNumber: isActive ? activeOrdinal : null,
            answer: answerRaw,
            state: isActive
                ? String(srcMetric.state || (answerRaw ? 'detected' : 'review')).trim()
                : 'ignored',
            rawAnswer: isActive ? String(srcMetric.rawAnswer || '').trim().toUpperCase() : '',
            confidence: isActive
                ? Number(srcMetric.confidence ?? sourceConfidence[qNum - 1] ?? 0)
                : 1
        };

        maskedAnswers.push(answerRaw);
        maskedMetrics.push(metric);
        maskedConfidence[qNum - 1] = metric.confidence;
    }

    return {
        ...omrResult,
        answers: maskedAnswers,
        questionMetrics: maskedMetrics,
        confidence: maskedConfidence,
        activeQuestionNumbers: activeQuestionList,
        activeQuestionCount: activeQuestionList.length,
        totalTemplateQuestions: total
    };
}

function suppressLikelyFalsePositiveBlank(omrResult = {}) {
    const normalizeIdentityValue = (value) => {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return '';
        const normalized = raw.toLowerCase();
        if (
            normalized === '-'
            || normalized === '--'
            || normalized === 'n/a'
            || normalized === 'na'
            || normalized === 'none'
            || normalized === 'null'
            || normalized === 'undefined'
            || normalized === 'unknown'
        ) {
            return '';
        }
        return raw;
    };

    const answers = Array.isArray(omrResult.answers) ? [...omrResult.answers] : [];
    const metrics = Array.isArray(omrResult.questionMetrics) ? [...omrResult.questionMetrics] : [];
    if (answers.length === 0 || metrics.length === 0) return { result: omrResult, suppressed: false };

    const barcodeStatus = String(omrResult.barcodeStatus || '').trim().toLowerCase();
    const hasQrIdentity = barcodeStatus === 'qr_success' || barcodeStatus === 'success';
    const hasEntry = Boolean(normalizeIdentityValue(omrResult.entryType));
    const hasEquity = Boolean(normalizeIdentityValue(omrResult.equityGroup));

    // Only run this guard when we have weak identity signals.
    if (hasQrIdentity || hasEntry || hasEquity) {
        return { result: omrResult, suppressed: false };
    }

    const detected = [];
    for (let i = 0; i < answers.length; i++) {
        const ans = String(answers[i] || '').trim().toUpperCase();
        if (ans) detected.push(ans);
    }
    const detectedCount = detected.length;
    if (detectedCount < 25) return { result: omrResult, suppressed: false };

    const freq = new Map();
    for (const ans of detected) freq.set(ans, (freq.get(ans) || 0) + 1);
    let dominantCount = 0;
    let dominantOption = '';
    for (const [option, count] of freq.entries()) {
        if (count > dominantCount) {
            dominantCount = count;
            dominantOption = option;
        }
    }
    const dominantRatio = dominantCount / Math.max(1, detectedCount);

    // Heuristic: blank-sheet false positives are usually dominated by one option (often B)
    // and have many "detected" answers with no valid identity reads.
    const suspicious = dominantRatio >= 0.82 && detectedCount >= Math.ceil(answers.length * 0.35);
    if (!suspicious) return { result: omrResult, suppressed: false };

    const suppressedAnswers = answers.map(() => '');
    const suppressedMetrics = metrics.map((metric, idx) => {
        const base = metric && typeof metric === 'object' ? metric : {};
        return {
            ...base,
            questionNumber: Number(base.questionNumber || base.question || (idx + 1)),
            answer: '',
            rawAnswer: '',
            state: 'review',
            confidence: Math.min(0.35, Number(base.confidence || 0.35))
        };
    });

    const notes = Array.isArray(omrResult.warnings) ? [...omrResult.warnings] : [];
    notes.push(
        `Auto-suppressed likely blank-sheet false positive (dominant=${dominantOption}:${Math.round(dominantRatio * 100)}%, detected=${detectedCount}/${answers.length}).`
    );

    return {
        result: {
            ...omrResult,
            answers: suppressedAnswers,
            questionMetrics: suppressedMetrics,
            confidence: Object.fromEntries(suppressedMetrics.map((q, idx) => [idx, q.confidence || 0.35])),
            detectionCoverage: 0,
            overallConfidence: 0,
            warnings: notes,
            falsePositiveSuppressed: true,
            falsePositiveSuppressionReason: `dominant=${dominantOption}:${Math.round(dominantRatio * 100)}%, detected=${detectedCount}/${answers.length}`
        },
        suppressed: true
    };
}

/** Build full answer array for a quiz from `quizzes.correct_answers` or `answer_keys` rows */
async function getCorrectAnswersForQuiz(quizId) {
    const quizRows = await database.query(
        'SELECT correct_answers FROM quizzes WHERE id = ?',
        [quizId]
    );
    if (quizRows[0]?.correct_answers) {
        try {
            const parsed = JSON.parse(quizRows[0].correct_answers);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch (e) {
            /* fall through */
        }
    }
    const keyRows = await database.query(
        `SELECT question_number, correct_answer FROM answer_keys
         WHERE quiz_id = ? ORDER BY question_number ASC`,
        [quizId]
    );
    if (!keyRows.length) return null;
    const maxN = Math.max(...keyRows.map((r) => r.question_number));
    const out = new Array(maxN).fill('');
    for (const r of keyRows) {
        out[r.question_number - 1] = r.correct_answer != null ? String(r.correct_answer) : '';
    }
    return out;
}

function normalizeScanRow(scan) {
    let answers = scan.answers;
    if (typeof answers === 'string') {
        try {
            answers = JSON.parse(answers);
        } catch (e) {
            answers = [];
        }
    }
    if (!Array.isArray(answers)) answers = [];
    const pct = scan.percentage != null ? Number(scan.percentage) : 0;
    return {
        id: scan.id,
        quizId: scan.quiz_id,
        studentName: scan.student_name,
        answers,
        score: scan.score,
        totalQuestions: scan.total_questions,
        percentage: pct,
        photo: scan.photo,
        timestamp: scan.timestamp,
        quizTitle: scan.quiz_title || null,
        entryType: scan.entry_type,
        specialEquityGroup: scan.special_equity_group
    };
}

function normalizeStoredImagePath(value) {
    const imagePath = String(value || '').trim();
    if (!imagePath) return null;
    if (imagePath.startsWith('/uploads/')) return imagePath;
    if (imagePath.includes('/api/uploads/')) {
        return imagePath.replace(/.*\/api\/uploads\//, '/uploads/');
    }
    return null;
}

function resolveStoredImageAbsolutePath(value) {
    const storedPath = normalizeStoredImagePath(value);
    if (!storedPath) return null;
    return path.join(runtimePaths.dataDir, storedPath.replace(/^\/+/, ''));
}

const ACTIVE_SCAN_RECORD_EXISTS_SQL = `
    AND EXISTS (
        SELECT 1
        FROM records r
        WHERE (
            s.image_path IS NOT NULL
            AND r.image_path = s.image_path
        )
        OR (
            s.image_path IS NULL
            AND r.student_name = s.student_name
            AND COALESCE(r.quiz_id, 0) = COALESCE(s.quiz_id, 0)
            AND ABS(strftime('%s', r.timestamp) - strftime('%s', s.timestamp)) <= 5
        )
    )
`;

function unlinkStoredImageIfPresent(value) {
    const fullPath = resolveStoredImageAbsolutePath(value);
    if (fullPath && fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
    }
}

async function deleteScanImageFiles(rows = []) {
    const seen = new Set();
    for (const row of rows) {
        for (const value of [row?.image_path, row?.thumbnail_path, row?.storage_path]) {
            const storedPath = normalizeStoredImagePath(value);
            if (!storedPath || seen.has(storedPath)) continue;
            seen.add(storedPath);
            unlinkStoredImageIfPresent(storedPath);
        }
    }
}

async function deleteScansAndRelated(scanRows = []) {
    if (!Array.isArray(scanRows) || scanRows.length === 0) {
        return 0;
    }

    const scanIds = [...new Set(scanRows.map(row => Number(row?.id)).filter(Number.isFinite))];
    if (scanIds.length === 0) {
        return 0;
    }

    await deleteScanImageFiles(scanRows);

    for (const scanId of scanIds) {
        await database.run('DELETE FROM subject_records WHERE scan_id = ?', [scanId]);
        await database.run('DELETE FROM scan_images WHERE scan_id = ?', [scanId]);
        await database.run('DELETE FROM scans WHERE id = ?', [scanId]);
    }

    return scanIds.length;
}

function describeDatabaseWriteState() {
    const dbPath = database.dbPath || runtimePaths.dbPath || 'unknown';
    const dbDir = path.dirname(dbPath);
    const parts = [`dbPath=${dbPath}`];

    for (const target of [dbDir, dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (!fs.existsSync(target)) continue;
        try {
            fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK);
            parts.push(`${target}=rw`);
        } catch (error) {
            parts.push(`${target}=not-writable:${error.code || error.message}`);
        }
    }

    return parts.join(' | ');
}

function sendDatabaseWriteError(res, error) {
    const message = `${error.message || 'Database write failed'} | ${describeDatabaseWriteState()}`;
    return res.status(500).json({ error: message });
}

function normalizeAnswerArray(answers) {
    return Array.isArray(answers)
        ? answers.map(answer => String(answer || '').trim().toUpperCase())
        : [];
}

async function getQuizSummary(quizId) {
    if (!quizId) {
        return { title: null, questionCount: 0 };
    }

    const rows = await database.query(
        'SELECT title, question_count, format, subject_config FROM quizzes WHERE id = ?',
        [quizId]
    );

    return {
        title: rows[0]?.title || null,
        questionCount: Number(rows[0]?.question_count) || 0,
        format: rows[0]?.format || 'multi-subject',
        subjectConfig: normalizeQuizSubjectConfig(
            rows[0]?.format === 'normal' ? 'normal' : 'multi-subject',
            parseSubjectConfigValue(rows[0]?.subject_config) || [],
            rows[0]?.title || '',
            Number(rows[0]?.question_count) || 100
        )
    };
}

function expandCompactQrCourse(course) {
    const text = String(course || '').trim();
    const map = {
        BSIT: 'Bachelor of Science in Information Technology',
        BSHM: 'Bachelor of Science in Hospitality Management',
        BSBA: 'Bachelor of Science in Business Administration',
        BSCRIM: 'Bachelor of Science in Criminology',
        BEED: 'Bachelor of Elementary Education',
        BSED: 'Bachelor of Secondary Education'
    };
    return map[text.toUpperCase()] || text;
}

function expandCompactQrDateTime(dateTime) {
    const text = String(dateTime || '').trim();
    const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!match) return text;
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;
}

function normalizeQrIdentityData(rawBarcodeData) {
    const source = (rawBarcodeData && typeof rawBarcodeData === 'object') ? rawBarcodeData : {};
    const firstNonEmpty = (...values) => {
        for (const value of values) {
            const text = String(value ?? '').trim();
            if (text) return text;
        }
        return '';
    };

    return {
        sheetId: firstNonEmpty(source.sheetId, source.sheet_id, source.formId, source.form_id, source.s),
        sheet_id: firstNonEmpty(source.sheet_id, source.sheetId, source.formId, source.form_id, source.s),
        studentId: firstNonEmpty(source.studentId, source.student_id, source.id, source.studentNo, source.student_no),
        examId: firstNonEmpty(source.examId, source.exam_id, source.quizId, source.quiz_id, source.testId, source.test_id, source.e),
        exam_id: firstNonEmpty(source.exam_id, source.examId, source.quizId, source.quiz_id, source.testId, source.test_id, source.e),
        studentName: firstNonEmpty(source.studentName, source.student_name, source.name, source.n),
        course: expandCompactQrCourse(firstNonEmpty(source.course, source.c)),
        age: firstNonEmpty(source.age, source.a),
        roomNo: firstNonEmpty(source.roomNo, source.room_no, source.room, source.r),
        dateTime: expandCompactQrDateTime(firstNonEmpty(source.dateTime, source.date_time, source.t))
    };
}

function isPlaceholderStudentName(value) {
    const text = String(value || '').trim().toLowerCase();
    return !text || text === 'android scan' || text === 'unknown student' || text === 'anonymous' || text === 'student';
}

function firstNonPlaceholderName(...values) {
    for (const value of values) {
        const cleaned = cleanExtractedField(value || '', 'name');
        if (cleaned && !isPlaceholderStudentName(cleaned)) {
            return cleaned;
        }
    }
    return '';
}

function firstNonEmptyText(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) return text;
    }
    return '';
}

async function resolveStudentMetadataFromQr(barcodeData = {}, quizId = null) {
    const qr = normalizeQrIdentityData(barcodeData);
    const sheetId = firstNonEmptyText(qr.sheetId, qr.sheet_id, qr.studentId);
    const examId = firstNonEmptyText(qr.examId, qr.exam_id);
    const selectedQuizId = firstNonEmptyText(quizId);

    if (!sheetId && !examId) {
        return {};
    }

    const fromRow = (row = {}) => ({
        sheetId: firstNonEmptyText(row.sheet_id, sheetId, qr.sheetId, qr.sheet_id),
        studentId: firstNonEmptyText(row.student_id),
        studentName: firstNonPlaceholderName(row.student_name, row.studentName),
        course: cleanExtractedField(row.course || '', 'course') || '',
        age: firstNonEmptyText(row.age),
        roomNo: firstNonEmptyText(row.room_no, row.roomNo),
        dateTime: firstNonEmptyText(row.exam_date_time, row.dateTime, row.date_time, qr.dateTime, qr.date_time),
        source: row._source || ''
    });

    if (sheetId) {
        const recordParams = [sheetId];
        let recordWhere = 'sheet_id = ?';
        if (selectedQuizId) {
            recordWhere += ' AND quiz_id = ?';
            recordParams.push(selectedQuizId);
        }
        const recordRows = await database.query(
            `SELECT sheet_id, student_id, student_name, course, age, room_no, 'records' AS _source
             FROM records
             WHERE ${recordWhere}
             ORDER BY timestamp DESC, id DESC
             LIMIT 1`,
            recordParams
        );
        const recordMeta = fromRow(recordRows[0]);
        if (recordMeta.studentName) {
            return recordMeta;
        }

        const scanParams = [sheetId];
        let scanWhere = 'sheet_id = ?';
        if (selectedQuizId) {
            scanWhere += ' AND quiz_id = ?';
            scanParams.push(selectedQuizId);
        }
        const scanRows = await database.query(
            `SELECT sheet_id, student_id, student_name, course, room_no, 'scans' AS _source
             FROM scans
             WHERE ${scanWhere}
             ORDER BY timestamp DESC, id DESC
             LIMIT 1`,
            scanParams
        );
        const scanMeta = fromRow(scanRows[0]);
        if (scanMeta.studentName) {
            return scanMeta;
        }
    }

    if (sheetId || examId) {
        const paperParams = [];
        const paperWhere = [];
        if (sheetId) {
            paperWhere.push('(sheet_id = ? OR student_id = ?)');
            paperParams.push(sheetId, sheetId);
        }
        if (examId) {
            paperWhere.push('exam_id = ?');
            paperParams.push(examId);
        }
        const paperRows = await database.query(
            `SELECT student_id, sheet_id, student_name, course, age, room_no, 'received_papers' AS _source
             FROM received_papers
             WHERE ${paperWhere.join(' AND ')}
             ORDER BY timestamp DESC, id DESC
             LIMIT 1`,
            paperParams
        );
        const paperMeta = fromRow(paperRows[0]);
        if (paperMeta.studentName) {
            return {
                ...paperMeta,
                sheetId: firstNonEmptyText(paperMeta.sheetId, sheetId)
            };
        }
    }

    return sheetId ? { sheetId, source: 'qr' } : {};
}

async function createAutomaticRecord({
    studentId,
    studentName,
    quizId,
    quizTitle,
    score,
    totalQuestions,
    percentage,
    status,
    entryType,
    residencyType,
    equityGroup,
    examDateTime,
    subjectCode,
    subject,
    section,
    course,
    age,
    roomNo,
    answers,
    rawText,
    imagePath,
    sourceReceivedPaperId,
    reviewStatus
}) {
    const answerArray = normalizeAnswerArray(answers);
    const numericScore = Number(score) || 0;
    const numericTotal = Number(totalQuestions) || answerArray.length || 0;
    const numericPercentage = Number.isFinite(Number(percentage))
        ? Number(Number(percentage).toFixed(1))
        : (numericTotal > 0 ? Number(((numericScore / numericTotal) * 100).toFixed(1)) : 0);
    const finalStatus = normalizeStatusValue(status) || (numericPercentage >= 75 ? 'PASS' : 'FAIL');

    const result = await database.run(
        `INSERT INTO records (
            student_id, student_name, quiz_id, quiz_title, score, total_questions, percentage, status,
            entry_type, residency_type, special_equity_group, exam_date_time, subject_code, subject, section, course, age, room_no, seat_no, answers,
            raw_text, image_path, source_received_paper_id, review_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            String(studentId || `AUTO-${Date.now()}`),
            String(studentName || '').trim() || 'Anonymous',
            quizId || null,
            quizTitle || null,
            numericScore,
            numericTotal,
            numericPercentage,
            finalStatus,
            entryType || null,
            residencyType || null,
            equityGroup || null,
            examDateTime || null,
            subjectCode || null,
            subject || null,
            section || null,
            course || null,
            age || null,
            roomNo || null,
            null,
            JSON.stringify(answerArray),
            rawText || null,
            normalizeStoredImagePath(imagePath),
            sourceReceivedPaperId || null,
            reviewStatus || 'auto_scanned'
        ]
    );

    return result.id;
}

async function removeQueuedPaper(id, imagePath = null) {
    if (!id) return;

    try {
        // Mark as scanned instead of deleting to support Inbox filters
        await database.run('UPDATE received_papers SET is_scanned = 1 WHERE id = ?', [id]);
        console.log(`[Inbox] Paper ${id} marked as scanned.`);
    } catch (error) {
        console.warn(`Could not mark processed received_papers entry ${id} as scanned: ${error.message}`);
    }
}

// --- MIDDLEWARE ---

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- CHUNKED BACKUP UPLOAD ENDPOINTS ---
const UPLOAD_SESSIONS_ROOT = path.join(runtimePaths.tmpDir, 'backup-uploads');

function ensureUploadSessionsRoot() {
    if (!fs.existsSync(UPLOAD_SESSIONS_ROOT)) {
        fs.mkdirSync(UPLOAD_SESSIONS_ROOT, { recursive: true });
    }
}

// --- PUBLIC ROUTES ---

router.post('/system/backup/upload/start', authenticateToken, async (req, res) => {
    try {
        const { fileName, totalSize, totalChunks } = req.body;
        if (!fileName || !totalSize || !totalChunks) {
            return res.status(400).json({ success: false, error: 'Invalid upload manifest' });
        }

        console.log(`[Upload] Starting session for ${fileName} (${totalSize} bytes, ${totalChunks} chunks)`);
        
        ensureUploadSessionsRoot();
        const uploadId = crypto.randomBytes(16).toString('hex');
        const sessionDir = path.join(UPLOAD_SESSIONS_ROOT, uploadId);
        fs.mkdirSync(sessionDir, { recursive: true });

        const metadata = { fileName, totalSize, totalChunks, uploadId, startedAt: Date.now() };
        fs.writeFileSync(path.join(sessionDir, 'metadata.json'), JSON.stringify(metadata));

        res.json({ success: true, uploadId });
    } catch (error) {
        console.error('[Upload] Start Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/system/backup/upload/chunk', authenticateToken, async (req, res) => {
    const uploadId = req.headers['x-upload-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
    
    if (!uploadId || isNaN(chunkIndex)) {
        return res.status(400).json({ success: false, error: 'Missing upload headers' });
    }

    const sessionDir = path.join(UPLOAD_SESSIONS_ROOT, uploadId);
    if (!fs.existsSync(sessionDir)) {
        return res.status(404).json({ success: false, error: 'Upload session not found' });
    }

    const chunkPath = path.join(sessionDir, `chunk-${chunkIndex}`);
    
    try {
        const bytesReceived = await streamRequestToFile(req, chunkPath);
        console.log(`[Upload] Received chunk ${chunkIndex} for ${uploadId} (${bytesReceived} bytes)`);
        res.json({ success: true, chunkIndex });
    } catch (error) {
        console.error('[Upload] Chunk Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/system/backup/upload/complete', authenticateToken, async (req, res) => {
    try {
        const { uploadId } = req.body;
        const sessionDir = path.join(UPLOAD_SESSIONS_ROOT, uploadId);
        
        if (!fs.existsSync(sessionDir)) {
            return res.status(404).json({ success: false, error: 'Upload session not found' });
        }

        const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'metadata.json'), 'utf8'));
        const finalZipPath = path.join(sessionDir, metadata.fileName);

        console.log(`[Upload] Completing upload ${uploadId}. Merging ${metadata.totalChunks} chunks...`);
        const writeStream = fs.createWriteStream(finalZipPath);
        
        for (let i = 0; i < metadata.totalChunks; i++) {
            const chunkPath = path.join(sessionDir, `chunk-${i}`);
            if (!fs.existsSync(chunkPath)) {
                writeStream.destroy();
                throw new Error(`Missing chunk ${i} in session ${uploadId}`);
            }
            writeStream.write(fs.readFileSync(chunkPath));
            safeUnlink(chunkPath);
        }
        
        writeStream.end();
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        console.log(`[Upload] Merge complete: ${finalZipPath}`);
        res.json({ success: true, fileName: metadata.fileName, uploadId });
    } catch (error) {
        console.error('[Upload] Complete Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check and System Info
router.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

router.get('/qr', (req, res) => {
    try {
        const data = String(req.query.data || '');
        if (!data) {
            return res.status(400).json({ error: 'QR data is required' });
        }
        if (data.length > 4096) {
            return res.status(413).json({ error: 'QR data is too large' });
        }

        const size = Math.min(1800, Math.max(96, Number.parseInt(String(req.query.size || '900'), 10) || 900));
        const margin = Math.min(20, Math.max(0, Number.parseInt(String(req.query.margin || '8'), 10) || 8));
        const ecc = String(req.query.ecc || 'H').trim().toUpperCase();
        const pythonCmd = getCalibrationPythonCommand();
        const script = [
            'import io, sys',
            'import qrcode',
            'level = {"L": qrcode.constants.ERROR_CORRECT_L, "M": qrcode.constants.ERROR_CORRECT_M, "Q": qrcode.constants.ERROR_CORRECT_Q, "H": qrcode.constants.ERROR_CORRECT_H}.get(sys.argv[4], qrcode.constants.ERROR_CORRECT_H)',
            'qr = qrcode.QRCode(error_correction=level, box_size=10, border=int(sys.argv[3]))',
            'qr.add_data(sys.argv[1])',
            'qr.make(fit=True)',
            'img = qr.make_image(fill_color="black", back_color="white").convert("RGB")',
            'target = int(sys.argv[2])',
            'img = img.resize((target, target))',
            'buf = io.BytesIO()',
            'img.save(buf, format="PNG")',
            'sys.stdout.buffer.write(buf.getvalue())'
        ].join('; ');

        const result = spawnSync(pythonCmd, ['-c', script, data, String(size), String(margin), ecc], {
            cwd: runtimePaths.repoRoot,
            encoding: null,
            maxBuffer: 10 * 1024 * 1024
        });

        if (result.error || result.status !== 0) {
            const detail = result.error?.message || Buffer.from(result.stderr || '').toString('utf8').trim() || 'QR generation failed';
            return res.status(503).json({ error: detail });
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        return res.send(result.stdout);
    } catch (error) {
        return res.status(500).json({ error: error.message || 'QR generation failed' });
    }
});

// Auth endpoints
router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        const userCountRows = await database.query('SELECT COUNT(*) as total FROM users');
        const hasExistingUsers = Number(userCountRows[0]?.total || 0) > 0;
        if (hasExistingUsers) {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];
            if (!token) {
                return res.status(403).json({ error: 'Registration is restricted after initial setup' });
            }

            try {
                jwt.verify(token, JWT_SECRET);
            } catch (error) {
                return res.status(403).json({ error: 'Registration is restricted after initial setup' });
            }
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await database.run(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );
        res.json({ id: result.id, username });
    } catch (error) {
        const message = String(error?.message || '');
        if (error?.code === 'SQLITE_CONSTRAINT' || 
            message.includes('SQLITE_CONSTRAINT') || 
            message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: message || 'Internal server error' });
    }
});

router.get('/system/info', async (req, res) => {
    try {
        const port = fs.existsSync(runtimePaths.currentPortFile)
            ? fs.readFileSync(runtimePaths.currentPortFile, 'utf8').trim()
            : '3000';
        const interfaces = os.networkInterfaces();
        const localIps = [];
        const hotspotPattern = /^192\.168\.137\./;
        for (const values of Object.values(interfaces)) {
            for (const info of values || []) {
                if (info.family === 'IPv4' && !info.internal) {
                    localIps.push(info.address);
                }
            }
        }
        const uniqueIps = [...new Set(localIps)];

        // Find preferred IP, skipping the Microsoft Wi-Fi Direct hotspot (192.168.137.x)
        let preferredIp = uniqueIps.find(ip => {
            return !hotspotPattern.test(ip) &&
                (ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip));
        }) || uniqueIps.find(ip => !hotspotPattern.test(ip)) || uniqueIps[0] || '127.0.0.1';

        res.json({
            ip: preferredIp,
            ips: uniqueIps,
            port,
            url: `http://${preferredIp}:${port}`,
            localhostUrl: `http://localhost:${port}`,
            mode: uniqueIps.length > 0 ? 'local-network' : 'localhost-only',
            localNetwork: true
        });
    } catch (error) {
        sendDatabaseWriteError(res, error);
    }
});

router.post('/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await database.query('SELECT * FROM users WHERE username = ?', [username]);
        if (user.length === 0) {
            return res.status(400).json({ error: 'Invalid username or password' });
        }

        const validPassword = await bcrypt.compare(password, user[0].password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid username or password' });
        }

        const token = jwt.sign({ id: user[0].id, username: user[0].username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ token });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/auth/refresh', (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.sendStatus(401);
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.sendStatus(403);
        }
        const freshToken = jwt.sign(
            { id: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );
        res.json({ token: freshToken });
    });
});

// --- PROTECTED ROUTES ---

// --- COURSE LOGOS ---
// Defaults are the tracked files in apps/web/images. An override is a user
// upload in .runtime/courselogos that replaces the default for this install
// only, so swapping a logo never dirties the repository with a multi-megabyte
// binary. Removing an override restores the course's own default; the default
// files themselves are never writable through this API.

const COURSE_LOGO_MAX_BYTES = 12 * 1024 * 1024;

function courseLogoDefaultPath(filename) {
    const safe = String(filename || '').trim();
    // Reject anything that could escape the images directory.
    if (!safe || safe.includes('/') || safe.includes('\\') || safe.includes('..')) return null;
    return path.join(runtimePaths.webRoot, 'images', safe);
}

function courseLogoOverridePath(code) {
    const safe = String(code || '').trim();
    if (!safe || !/^[A-Za-z0-9_-]+$/.test(safe)) return null;
    return path.join(runtimePaths.courseLogosDir, `${safe}.png`);
}

function isPngBuffer(buffer) {
    // PNG magic number. Cheap enough to reject anything that is not an image
    // before it is written to disk.
    return buffer.length > 8
        && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
        && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
}

function decodeLogoDataUrl(dataUrl) {
    const match = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
        throw new Error('Logo must be a PNG supplied as a base64 data URL.');
    }
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length === 0) {
        throw new Error('Uploaded logo was empty.');
    }
    if (buffer.length > COURSE_LOGO_MAX_BYTES) {
        throw new Error(`Logo exceeds the ${Math.round(COURSE_LOGO_MAX_BYTES / 1048576)}MB limit.`);
    }
    if (!isPngBuffer(buffer)) {
        throw new Error('Uploaded file is not a valid PNG image.');
    }
    return buffer;
}

function describeCourseLogo(course) {
    const overridePath = course.overrideLogo ? courseLogoOverridePath(course.code) : null;
    const hasOverride = Boolean(overridePath && fs.existsSync(overridePath));
    const defaultPath = course.defaultLogo ? courseLogoDefaultPath(course.defaultLogo) : null;
    const hasDefault = Boolean(defaultPath && fs.existsSync(defaultPath));

    const source = hasOverride ? 'override' : (hasDefault ? 'default' : 'none');
    const url = hasOverride
        ? `/courselogos/${course.code}.png`
        : (hasDefault ? `images/${course.defaultLogo}` : null);

    return {
        code: course.code,
        name: course.name,
        aliases: course.aliases,
        logoUrl: url,
        logoSource: source,
        hasOverride,
        hasDefault,
        logoScale: course.logoScale,
        defaultLogo: course.defaultLogo,
        overrideLogo: hasOverride ? `${course.code}.png` : null
    };
}

router.get('/courses', authenticateToken, async (_req, res) => {
    try {
        const courses = await database.getCourses();
        return res.json({
            success: true,
            defaultDirectory: path.join(runtimePaths.webRoot, 'images'),
            overrideDirectory: runtimePaths.courseLogosDir,
            courses: courses.map(describeCourseLogo)
        });
    } catch (error) {
        console.error('[Courses] list failed:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/courses/logo', authenticateToken, async (req, res) => {
    try {
        const code = String(req.body?.code || '').trim();
        const course = await database.getCourseByInput(code);
        if (!course) {
            return res.status(404).json({ success: false, error: `Unknown course: ${code}` });
        }

        const buffer = decodeLogoDataUrl(req.body?.dataUrl);
        const target = courseLogoOverridePath(course.code);
        if (!target) {
            return res.status(400).json({ success: false, error: 'Invalid course code.' });
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);

        await database.run('UPDATE courses SET override_logo = ?, updated_at = ? WHERE code = ?', [
            `${course.code}.png`,
            new Date().toISOString(),
            course.code
        ]);

        const [updated] = (await database.getCourses()).filter((item) => item.code === course.code);
        return res.json({ success: true, course: describeCourseLogo(updated) });
    } catch (error) {
        console.error('[Courses] replace failed:', error.message);
        return res.status(400).json({ success: false, error: error.message });
    }
});

// Removes the override only. The course falls back to its own default logo;
// the shipped file in apps/web/images is never touched.
router.delete('/courses/logo/:code', authenticateToken, async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        const course = await database.getCourseByInput(code);
        if (!course) {
            return res.status(404).json({ success: false, error: `Unknown course: ${code}` });
        }

        const target = courseLogoOverridePath(course.code);
        if (target && fs.existsSync(target)) {
            fs.unlinkSync(target);
        }
        await database.run('UPDATE courses SET override_logo = NULL, updated_at = ? WHERE code = ?', [
            new Date().toISOString(),
            course.code
        ]);

        const [updated] = (await database.getCourses()).filter((item) => item.code === course.code);
        return res.json({ success: true, course: describeCourseLogo(updated) });
    } catch (error) {
        console.error('[Courses] remove failed:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Quiz endpoints
router.get('/quizzes', authenticateToken, async (req, res) => {
    try {
        const showArchived = req.query.archived === '1';
        const whereClause = showArchived
            ? 'WHERE archived = 1'
            : 'WHERE archived IS NULL OR archived = 0';
        const quizzes = await database.query(`
            SELECT id, title, question_count as questionCount, options, format, subject_config as subjectConfig, correct_answers as correctAnswers, created_at as createdAt 
            FROM quizzes 
            ${whereClause}
            ORDER BY created_at DESC
        `);
        const parsedQuizzes = quizzes.map(quiz => ({
            ...quiz,
            subjectConfig: normalizeQuizSubjectConfig(
                quiz.format === 'normal' ? 'normal' : 'multi-subject',
                parseSubjectConfigValue(quiz.subjectConfig) || quiz.subjectConfig,
                quiz.title,
                quiz.questionCount
            ),
            correctAnswers: quiz.correctAnswers ? JSON.parse(quiz.correctAnswers) : null
        }));
        res.json(parsedQuizzes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/quizzes', authenticateToken, async (req, res) => {
    try {
        const { correctAnswers } = req.body;
        const normalizedQuiz = normalizeQuizPayload(req.body);
        const result = await database.run(
            'INSERT INTO quizzes (title, question_count, options, format, subject_config, correct_answers) VALUES (?, ?, ?, ?, ?, ?)',
            [
                normalizedQuiz.title,
                normalizedQuiz.questionCount,
                normalizedQuiz.options,
                normalizedQuiz.format,
                JSON.stringify(normalizedQuiz.subjectConfig),
                correctAnswers ? JSON.stringify(correctAnswers) : null
            ]
        );
        
        const newQuiz = await database.query(
            'SELECT id, title, question_count as questionCount, options, format, subject_config as subjectConfig, correct_answers as correctAnswers, created_at as createdAt FROM quizzes WHERE id = ?',
            [result.id]
        );
        
        newQuiz[0].subjectConfig = normalizeQuizSubjectConfig(
            newQuiz[0].format === 'normal' ? 'normal' : 'multi-subject',
            parseSubjectConfigValue(newQuiz[0].subjectConfig) || newQuiz[0].subjectConfig,
            newQuiz[0].title,
            newQuiz[0].questionCount
        );
        if (newQuiz[0].correctAnswers) {
            newQuiz[0].correctAnswers = JSON.parse(newQuiz[0].correctAnswers);
        }
        
        res.json(newQuiz[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/quizzes/:id', authenticateToken, async (req, res) => {
    try {
        const { correctAnswers } = req.body;
        const hasCorrectAnswers = Object.prototype.hasOwnProperty.call(req.body || {}, 'correctAnswers');
        const normalizedQuiz = normalizeQuizPayload(req.body);
        await database.run(
            `UPDATE quizzes
             SET title = ?, question_count = ?, options = ?, format = ?, subject_config = ?,
                 correct_answers = CASE WHEN ? THEN ? ELSE correct_answers END
             WHERE id = ?`,
            [
                normalizedQuiz.title,
                normalizedQuiz.questionCount,
                normalizedQuiz.options,
                normalizedQuiz.format,
                JSON.stringify(normalizedQuiz.subjectConfig),
                hasCorrectAnswers ? 1 : 0,
                hasCorrectAnswers ? JSON.stringify(correctAnswers || []) : null,
                req.params.id
            ]
        );
        
        const updatedQuiz = await database.query(
            'SELECT id, title, question_count as questionCount, options, format, subject_config as subjectConfig, correct_answers as correctAnswers, created_at as createdAt FROM quizzes WHERE id = ?',
            [req.params.id]
        );
        
        updatedQuiz[0].subjectConfig = normalizeQuizSubjectConfig(
            updatedQuiz[0].format === 'normal' ? 'normal' : 'multi-subject',
            parseSubjectConfigValue(updatedQuiz[0].subjectConfig) || updatedQuiz[0].subjectConfig,
            updatedQuiz[0].title,
            updatedQuiz[0].questionCount
        );
        if (updatedQuiz[0].correctAnswers) {
            updatedQuiz[0].correctAnswers = JSON.parse(updatedQuiz[0].correctAnswers);
        }
        
        res.json(updatedQuiz[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/records/:id', authenticateToken, async (req, res) => {
    try {
        const {
            studentName,
            sheetId,
            sheet_id,
            course,
            subject,
            section,
            age,
            roomNo,
            examDateTime,
            entryType,
            specialEquityGroup,
            score,
            totalQuestions,
            percentage,
            status,
            answers,
            reviewStatus
        } = req.body;

        const result = await database.run(
            `UPDATE records SET 
                student_name = ?, 
                sheet_id = COALESCE(?, sheet_id),
                course = ?, 
                subject = ?, 
                section = ?, 
                age = ?, 
                room_no = ?, 
                exam_date_time = COALESCE(?, exam_date_time),
                entry_type = ?, 
                special_equity_group = ?, 
                score = ?, 
                total_questions = ?, 
                percentage = ?, 
                status = ?, 
                answers = COALESCE(?, answers),
                review_status = COALESCE(?, review_status)
            WHERE id = ?`,
            [
                studentName,
                sheetId || sheet_id || null,
                course,
                subject,
                section,
                age,
                roomNo,
                examDateTime,
                entryType,
                specialEquityGroup,
                score,
                totalQuestions,
                percentage,
                status,
                answers == null ? null : (Array.isArray(answers) ? JSON.stringify(answers) : answers),
                reviewStatus || null,
                req.params.id
            ]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const updatedRecord = await database.query('SELECT * FROM records WHERE id = ?', [req.params.id]);
        res.json(updatedRecord[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Soft-delete (archive) a quiz — preserves student data by keeping quiz_id reference
router.delete('/quizzes/:id', authenticateToken, async (req, res) => {
    try {
        const id = req.params.id;

        // Soft-delete the quiz itself (archive) — records keep their quiz_id reference
        await database.run('UPDATE quizzes SET archived = 1 WHERE id = ?', [id]);

        res.json({ message: 'Quiz archived. Student data preserved.', archived: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Restore an archived quiz
router.post('/quizzes/:id/restore', authenticateToken, async (req, res) => {
    try {
        const id = req.params.id;
        const result = await database.run('UPDATE quizzes SET archived = 0 WHERE id = ? AND archived = 1', [id]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Archived quiz not found' });
        }

        res.json({ message: 'Quiz restored successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Permanently delete an archived quiz and all related data (irreversible)
router.delete('/quizzes/:id/permanent', authenticateToken, async (req, res) => {
    try {
        await database.assertWritable();
        const id = req.params.id;

        const quizRows = await database.query('SELECT id, archived FROM quizzes WHERE id = ?', [id]);
        if (quizRows.length === 0) {
            return res.status(404).json({ error: 'Quiz not found' });
        }
        if (Number(quizRows[0].archived) !== 1) {
            return res.status(400).json({ error: 'Only archived answer keys can be permanently deleted' });
        }

        // Delete linked scans and their files/children first (FK-safe order)
        const scanRows = await database.query(
            'SELECT id, image_path, thumbnail_path FROM scans WHERE quiz_id = ?',
            [id]
        );
        const deletedScans = await deleteScansAndRelated(scanRows);

        // Records keep a quiz_id reference — delete them before the quiz
        const recordsResult = await database.run('DELETE FROM records WHERE quiz_id = ?', [id]);

        await database.run('DELETE FROM answer_keys WHERE quiz_id = ?', [id]);
        await database.run('DELETE FROM quizzes WHERE id = ?', [id]);

        res.json({
            success: true,
            deletedScans,
            deletedRecords: recordsResult.changes,
            message: 'Answer key permanently deleted.'
        });
    } catch (error) {
        sendDatabaseWriteError(res, error);
    }
});

// Answer Key endpoints
router.get('/quizzes/:quizId/answer-key', authenticateToken, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const arr = await getCorrectAnswersForQuiz(quizId);
        res.json({ answers: arr || [] });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/quizzes/:quizId/answer-key', authenticateToken, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const { answers } = req.body;
        
        // Get quiz info to check question count and subject
        const quizRows = await database.query('SELECT question_count, subject_id, format FROM quizzes WHERE id = ?', [quizId]);
        if (quizRows.length === 0) return res.status(404).json({ error: 'Quiz not found' });
        
        const quiz = quizRows[0];
        const isMultiSubject = String(quiz.format || '').trim() === 'multi-subject';
        const expectedCount = Number(quiz.question_count) || (isMultiSubject ? 100 : 0);
        const answerArray = Array.isArray(answers) ? answers : [];
        const normalizedAnswers = expectedCount > 0
            ? Array.from({ length: expectedCount }, (_, idx) => String(answerArray[idx] || '').trim().toUpperCase())
            : answerArray.map((item) => String(item || '').trim().toUpperCase());

        await database.run('DELETE FROM answer_keys WHERE quiz_id = ?', [quizId]);
        
        const subjectBoundaries = {
            ENG: { start: 1, end: 20 },
            SCI: { start: 21, end: 40 },
            MATH: { start: 41, end: 60 },
            GEN: { start: 61, end: 80 },
            ABS: { start: 81, end: 100 }
        };

        for (let i = 0; i < normalizedAnswers.length; i++) {
            const qNum = i + 1;
            let subjectId = quiz.subject_id;

            if (isMultiSubject) {
                // Determine subject for this question in multi-subject layout
                let subCode = null;
                for (const [code, range] of Object.entries(subjectBoundaries)) {
                    if (qNum >= range.start && qNum <= range.end) {
                        subCode = code;
                        break;
                    }
                }

                if (subCode) {
                    const subject = await database.query('SELECT id FROM subjects WHERE code = ?', [subCode]);
                    if (subject.length > 0) {
                        subjectId = subject[0].id;
                        
                        await database.run(
                            'INSERT INTO answer_keys (quiz_id, subject_id, question_number, correct_answer) VALUES (?, ?, ?, ?)',
                            [quizId, subjectId, qNum, normalizedAnswers[i]]
                        );
                    }
                }
            } else {
                await database.run(
                    'INSERT INTO answer_keys (quiz_id, subject_id, question_number, correct_answer) VALUES (?, ?, ?, ?)',
                    [quizId, subjectId, qNum, normalizedAnswers[i]]
                );
            }
        }
        
        await database.run('UPDATE quizzes SET correct_answers = ? WHERE id = ?', [JSON.stringify(normalizedAnswers), quizId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error saving answer key:', error);
        res.status(500).json({ error: error.message });
    }
});

router.delete('/quizzes/:quizId/answer-key', authenticateToken, async (req, res) => {
    try {
        const quizId = req.params.quizId;

        const quizRows = await database.query('SELECT id FROM quizzes WHERE id = ?', [quizId]);
        if (!quizRows.length) {
            return res.status(404).json({ error: 'Quiz not found' });
        }

        await database.run('DELETE FROM answer_keys WHERE quiz_id = ?', [quizId]);
        await database.run('UPDATE quizzes SET correct_answers = NULL WHERE id = ?', [quizId]);

        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting answer key:', error);
        return res.status(500).json({ error: error.message });
    }
});

router.get('/scans', authenticateToken, async (req, res) => {
    try {
        await ensureSubjectScoreBackfill();
        const { page = 1, limit = 50, quizId, department, status, entryType, residencyType, equityGroup } = req.query;
        const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
        const limitNumber = Math.max(parseInt(limit, 10) || 50, 1);
        const offset = (pageNumber - 1) * limitNumber;

        let query = `
            SELECT s.*, q.title as quiz_title
            FROM scans s
            LEFT JOIN quizzes q ON s.quiz_id = q.id
            WHERE 1=1
        `;
        const params = [];
        // Excluding the ACTIVE_SCAN_RECORD_EXISTS_SQL filter (it references s.image_path which may not exist in older scans)
        // query += ACTIVE_SCAN_RECORD_EXISTS_SQL;
        // countQuery must mirror the main query so pagination.total matches the returned rows
        let countQuery = `SELECT COUNT(*) as total FROM scans s WHERE 1=1`;
        const countParams = [];

        const addFilter = (sql, ...values) => {
            query += sql;
            countQuery += sql;
            params.push(...values);
            countParams.push(...values);
        };

        if (quizId) {
            addFilter(' AND s.quiz_id = ?', quizId);
        }

        if (department) {
            addFilter(' AND s.department = ?', department);
        }
        if (status) {
            const statusValues = expandStatusFilterValues(status);
            if (statusValues.length === 1) {
                addFilter(' AND (s.overall_status = ? OR s.status = ?)', statusValues[0], statusValues[0]);
            } else {
                addFilter(
                    ' AND ((s.overall_status IN (?, ?)) OR (s.status IN (?, ?)))',
                    statusValues[0], statusValues[1], statusValues[0], statusValues[1]
                );
            }
        }
        if (entryType) {
            addFilter(' AND s.entry_type = ?', entryType);
        }
        if (residencyType) {
            addFilter(' AND s.residency_type = ?', residencyType);
        }
        if (equityGroup) {
            addFilter(' AND s.special_equity_group = ?', equityGroup);
        }

        query += ' ORDER BY s.timestamp DESC LIMIT ? OFFSET ?';
        params.push(limitNumber, offset);

        const scans = await database.query(query, params);

        // Add image URLs
        const scansWithImages = scans.map(scan => ({
            ...scan,
            thumbnail_url: scan.thumbnail_path ? 
                `${req.protocol}://${req.get('host')}${scan.thumbnail_path}` : null,
            image_url: scan.image_path ? 
                `${req.protocol}://${req.get('host')}${scan.image_path}` : null
        }));

        // Get total count for pagination
        const totalResult = await database.query(countQuery, countParams);
        const total = totalResult[0].total;

        res.json({
            scans: scansWithImages,
            pagination: {
                page: pageNumber,
                limit: limitNumber,
                total: total,
                pages: Math.ceil(total / limitNumber)
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/scans/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const scan = await database.query(`
            SELECT s.*, q.title as quiz_title
            FROM scans s
            LEFT JOIN quizzes q ON s.quiz_id = q.id
            WHERE s.id = ?
        `, [id]);

        if (scan.length === 0) {
            return res.status(404).json({ error: 'Scan not found' });
        }

        const scanData = scan[0];
        
        // Add image URLs if available
        if (scanData.image_path) {
            scanData.image_url = `${req.protocol}://${req.get('host')}${scanData.image_path}`;
        }
        if (scanData.thumbnail_path) {
            scanData.thumbnail_url = `${req.protocol}://${req.get('host')}${scanData.thumbnail_path}`;
        }

        res.json(scanData);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve static images
router.use('/uploads', express.static(runtimePaths.uploadsDir));

// Delete scan with images
router.delete('/scans/:id', authenticateToken, async (req, res) => {
    try {
        await database.assertWritable();
        const { id } = req.params;

        const scan = await database.query('SELECT id, image_path, thumbnail_path FROM scans WHERE id = ?', [id]);
        await deleteScansAndRelated(scan);

        res.json({ success: true, message: 'Scan deleted successfully' });
    } catch (error) {
        sendDatabaseWriteError(res, error);
    }
});

// Records endpoints
router.get('/records', authenticateToken, async (req, res) => {
    try {
        const records = await database.query(`
            SELECT r.*, COALESCE(q.title, r.quiz_title) as quiz_title 
            FROM records r 
            LEFT JOIN quizzes q ON r.quiz_id = q.id 
            ORDER BY r.timestamp DESC
        `);
        res.json(records.map(record => ({
            ...record,
            answers: record.answers ? JSON.parse(record.answers) : [],
            image_url: record.image_path ? `${req.protocol}://${req.get('host')}${record.image_path}` : null
        })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/records', authenticateToken, async (req, res) => {
    try {
        const { sheet_id, sheetId, student_name, quiz_id, quiz_title, score, total_questions, percentage, entry_type, residency_type, special_equity_group, subject_code, answers } = req.body;
        const resolvedSheetId = String(sheet_id || sheetId || '').trim();
        const result = await database.run(
            'INSERT INTO records (sheet_id, student_id, student_name, quiz_id, quiz_title, score, total_questions, percentage, entry_type, residency_type, special_equity_group, subject_code, answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                resolvedSheetId || null,
                '',
                student_name || null,
                quiz_id || null,
                quiz_title || null,
                score || 0,
                total_questions || 0,
                percentage || 0,
                entry_type,
                residency_type,
                special_equity_group,
                subject_code,
                answers ? JSON.stringify(answers) : null
            ]
        );
        res.json({ id: result.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/records', authenticateToken, async (req, res) => {
    try {
        await database.assertWritable();
        const scanImages = await database.query(`
            SELECT image_path, thumbnail_path FROM scans
            UNION ALL
            SELECT storage_path as image_path, thumbnail_path FROM scan_images
        `);
        await deleteScanImageFiles(scanImages);

        await database.run('DELETE FROM subject_records');
        await database.run('DELETE FROM scan_images');
        await database.run('DELETE FROM scans');
        await database.run('DELETE FROM records');
        res.json({ success: true, message: 'Student records and scan results cleared.' });
    } catch (error) {
        sendDatabaseWriteError(res, error);
    }
});

router.delete('/records/:id', authenticateToken, async (req, res) => {
    try {
        await database.assertWritable();
        const { id } = req.params;
        const rows = await database.query(
            `SELECT id, student_name, quiz_id, score, total_questions, percentage, image_path, timestamp
             FROM records
             WHERE id = ?`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Record not found' });
        }

        const record = rows[0];
        let linkedScans = [];
        if (record.image_path) {
            linkedScans = await database.query(
                'SELECT id, image_path, thumbnail_path FROM scans WHERE image_path = ?',
                [record.image_path]
            );
        }

        if (linkedScans.length === 0) {
            linkedScans = await database.query(
                `SELECT id, image_path, thumbnail_path
                 FROM scans
                 WHERE student_name = ?
                   AND COALESCE(quiz_id, 0) = COALESCE(?, 0)
                   AND COALESCE(total_questions, 0) = COALESCE(?, 0)
                   AND ABS(strftime('%s', timestamp) - strftime('%s', ?)) <= 5`,
                [record.student_name, record.quiz_id, record.total_questions, record.timestamp]
            );
        }

        const deletedScans = await deleteScansAndRelated(linkedScans);
        await database.run('DELETE FROM records WHERE id = ?', [id]);
        res.json({ success: true, deletedScans, message: 'Record deleted successfully.' });
    } catch (error) {
        sendDatabaseWriteError(res, error);
    }
});

router.post('/records/ocr', authenticateToken, async (req, res) => {
    try {
        const {
            quiz_id,
            student_name,
            sheet_id,
            sheetId,
            student_id: extStudentId,
            course,
            subject,
            section,
            age,
            room_no,
            entry_type,
            residency_type,
            special_equity_group,
            exam_date_time,
            score: manualScore,
            answers,
            raw_text,
            image_path,
            source_received_paper_id
        } = req.body;


        if (!student_name || !String(student_name).trim()) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        let finalImagePath = image_path;

        // If image is base64, store it permanently
        if (image_path && image_path.startsWith('data:image/')) {
            try {
                const imageData = await processAndStoreImage(image_path, `OCR-${Date.now()}`);
                finalImagePath = imageData.imagePath;
            } catch (err) {
                console.warn('Failed to store OCR image file, saving as base64 instead:', err.message);
            }
        } else if (image_path && image_path.includes('/api/uploads/')) {
            // Convert URL back to path
            finalImagePath = image_path.replace(/.*\/api\/uploads\//, '/uploads/');
        }

        let quizTitle = null;
        let questionCount = 0;
        let correctAnswers = [];
        if (quiz_id) {
            const quizRows = await database.query('SELECT title, question_count FROM quizzes WHERE id = ?', [quiz_id]);
            if (quizRows.length > 0) {
                quizTitle = quizRows[0].title;
                questionCount = Number(quizRows[0].question_count);
                correctAnswers = await getCorrectAnswersForQuiz(quiz_id);
            }
        }

            const answerArray = Array.isArray(answers)
                ? answers.map(answer => String(answer || '').trim().toUpperCase())
                : [];
            // Calculate subject scores for OCR scans (new)            
            let subjectResults = await calculateSubjectScores(answerArray, quiz_id);
            
            let score = manualScore !== undefined && manualScore !== '' ? Number(manualScore) : null;
            let totalQuestions = questionCount || answerArray.length || 0;
            let percentage = 0;

        // If score not manually provided, calculate it
        if (score === null && quiz_id && correctAnswers.length > 0) {
            score = 0;
            for (let i = 0; i < totalQuestions; i++) {
                if (answerArray[i] && correctAnswers[i] && 
                    String(answerArray[i]).trim().toUpperCase() === String(correctAnswers[i]).trim().toUpperCase()) {
                    score++;
                }
            }
        }
        
        if (score === null) score = 0;

        if (totalQuestions > 0) {
            percentage = ((score / totalQuestions) * 100).toFixed(1);
        }

        const status = percentage >= 75 ? 'PASS' : 'FAIL';
        const quizSummary = await getQuizSummary(quiz_id);
        if (quizSummary.format === 'normal') {
            subjectResults = buildSingleSubjectResultsFromOverall({
                quizSummary,
                score,
                totalQuestions,
                percentage: Number.parseFloat(String(percentage || 0)) || 0,
                status
            });
        }

        const submittedRecordPaperId = String(sheet_id || sheetId || extStudentId || '').trim();
        const resolvedRecordPaperId = submittedRecordPaperId || generateShortOcrPaperId();
        const normalizedQuizId = Number.parseInt(String(quiz_id || 0), 10) || 0;
        const duplicateClauses = [];
        const duplicateParams = [normalizedQuizId];

        if (submittedRecordPaperId) {
            duplicateClauses.push('sheet_id = ?');
            duplicateParams.push(submittedRecordPaperId);
        }
        if (source_received_paper_id) {
            duplicateClauses.push('source_received_paper_id = ?');
            duplicateParams.push(source_received_paper_id);
        }
        if (finalImagePath) {
            duplicateClauses.push('image_path = ?');
            duplicateParams.push(finalImagePath);
        }

        if (duplicateClauses.length > 0) {
            const duplicateRows = await database.query(
                `SELECT id, sheet_id, student_name, quiz_id, timestamp
                 FROM records
                 WHERE COALESCE(quiz_id, 0) = ?
                   AND (${duplicateClauses.join(' OR ')})
                 ORDER BY timestamp DESC, id DESC
                 LIMIT 1`,
                duplicateParams
            );

            if (duplicateRows.length > 0) {
                return res.status(409).json({
                    success: false,
                    code: 'DUPLICATE_RECORD',
                    error: 'This paper has already been saved to records.',
                    existingRecordId: duplicateRows[0].id,
                    existingSheetId: duplicateRows[0].sheet_id || null,
                    existingStudentName: duplicateRows[0].student_name || null,
                    existingTimestamp: duplicateRows[0].timestamp || null
                });
            }
        }

        const result = await database.run(
            `INSERT INTO records (
                sheet_id, student_id, student_name, quiz_id, quiz_title, score, total_questions, percentage, status,
                entry_type, residency_type, special_equity_group, exam_date_time, subject, section, course, age, room_no, seat_no, answers, raw_text, image_path,
                source_received_paper_id, review_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                resolvedRecordPaperId,
                '',
                String(student_name).trim(),
                normalizedQuizId,
                quizTitle,
                score,
                totalQuestions,
                percentage,
                status,
                entry_type || null,
                residency_type || null,
                special_equity_group || null,
                exam_date_time || null,
                subject || null,
                section || null,
                course || null,
                age || null,
                room_no || null,
                null,
                JSON.stringify(answerArray),
                raw_text || null,
                finalImagePath || null,
                source_received_paper_id || null,
                'reviewed_raw'
            ]
        );

        // Keep Scan Results page in sync by mirroring OCR saves into scans table.
        try {
            const numericPercentage = Number.parseFloat(String(percentage || 0)) || 0;
            const scanStatus = numericPercentage >= 75 ? 'PASS' : 'FAIL';
            const legacyEng = getSubjectScoreEntry(subjectResults, 'ENG');
            const legacySci = getSubjectScoreEntry(subjectResults, 'SCI');
            const legacyMath = getSubjectScoreEntry(subjectResults, 'MATH');
            const legacyGen = getSubjectScoreEntry(subjectResults, 'GEN');
            const legacyAbs = getSubjectScoreEntry(subjectResults, 'ABS');
            const scanColumns = [
                'sheet_id', 'student_id', 'student_name', 'quiz_id', 'answers',
                'score', 'total_score', 'total_questions', 'percentage', 'overall_percentage',
                'status', 'overall_status',
                // SUBJECT columns – added for OCR scans
                'english_score', 'science_score', 'math_score', 'general_score', 'abstract_score',
                'english_percentage', 'science_percentage', 'math_percentage', 'general_percentage', 'abstract_percentage',
                'english_status', 'science_status', 'math_status', 'general_status', 'abstract_status',
                'image_path', 'course', 'room_no', 'seat_no',
                'score_breakdown', 'subject_scores',
                'entry_type', 'residency_type', 'special_equity_group', 'proctor_status', 'scanned_by'
            ];
            const scanValues = [
                resolvedRecordPaperId,
                '',
                String(student_name).trim(),
                normalizedQuizId || null,
                JSON.stringify(answerArray),
                score,
                score,
                totalQuestions,
                numericPercentage,
                numericPercentage,
                scanStatus,
                scanStatus,
                // --- SUBJECT VALUES ---------------------------------------------------
                legacyEng.score, legacySci.score, legacyMath.score, legacyGen.score, legacyAbs.score,
                legacyEng.percentage, legacySci.percentage, legacyMath.percentage, legacyGen.percentage, legacyAbs.percentage,
                legacyEng.status, legacySci.status, legacyMath.status, legacyGen.status, legacyAbs.status,
                // -----------------------------------------------------------------------
                finalImagePath || null,
                course || null,
                room_no || null,
                null,
                JSON.stringify(Object.fromEntries(Object.entries(subjectResults).filter(([key]) => !['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)).map(([key, value]) => [key, value?.score || 0]))),
                JSON.stringify(subjectResults),
                entry_type || null,
                residency_type || null,
                special_equity_group || null,
                'Not Verified',
                req.user?.username || null
            ];

            const mirroredScan = await database.run(
                `INSERT INTO scans (${scanColumns.join(', ')}) VALUES (${scanColumns.map(() => '?').join(', ')})`,
                scanValues
            );
            await saveSubjectRecordsForScan({
                scanId: mirroredScan.id,
                studentId: '',
                studentName: String(student_name).trim(),
                subjectResults,
                entryType: entry_type || null,
                residencyType: residency_type || null,
                equityGroup: special_equity_group || null,
                roomNo: room_no || null,
                examDateTime: exam_date_time || null
            });
        } catch (scanMirrorError) {
            console.warn('Could not mirror OCR record into scans table:', scanMirrorError.message);
        }

        // If it came from received papers, mark it as scanned
        if (source_received_paper_id) {
            await database.run('UPDATE received_papers SET is_scanned = 1 WHERE id = ?', [source_received_paper_id]);
        }

        res.status(201).json({ id: result.id, success: true });
    } catch (error) {
        console.error('Error saving OCR record:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/scores/report', authenticateToken, async (req, res) => {
    try {
        await ensureSubjectScoreBackfill();
        const { quizId, dateFrom, dateTo, entryType, equityGroup } = req.query;
        
        // End-of-day handling so a date-only dateTo includes the whole day
        const endOfDay = dateTo ? (dateTo.includes(' ') ? dateTo : `${dateTo} 23:59:59`) : '';
        
        let query = `
            SELECT s.*, q.title as quiz_title, s.total_score as score 
            FROM scans s 
            LEFT JOIN quizzes q ON s.quiz_id = q.id 
            WHERE 1=1
        `;
        const params = [];
        // Excluding the ACTIVE_SCAN_RECORD_EXISTS_SQL filter (it references s.image_path which may not exist in older scans)
        // query += ACTIVE_SCAN_RECORD_EXISTS_SQL;

        const addFilter = (sql, ...values) => {
            query += sql;
            params.push(...values);
        };

        if (quizId) {
            addFilter(' AND s.quiz_id = ?', quizId);
        }
        if (dateFrom) {
            addFilter(' AND s.timestamp >= ?', dateFrom);
        }
        if (endOfDay) {
            addFilter(' AND s.timestamp <= ?', endOfDay);
        }
        if (entryType) {
            addFilter(' AND s.entry_type = ?', entryType);
        }
        if (equityGroup) {
            addFilter(' AND s.special_equity_group = ?', equityGroup);
        }
        
        query += ' ORDER BY s.timestamp DESC';
        
        const scans = await database.query(query, params);

        // Student-based pass-rate calculation (Rule A), respecting the same filters
        const studentPassQuery = `
            WITH filtered_scans AS (
                SELECT *
                FROM scans s
                WHERE 1=1
                ${quizId ? 'AND s.quiz_id = ?' : ''}
                ${dateFrom ? 'AND s.timestamp >= ?' : ''}
                ${endOfDay ? 'AND s.timestamp <= ?' : ''}
                ${entryType ? 'AND s.entry_type = ?' : ''}
                ${equityGroup ? 'AND s.special_equity_group = ?' : ''}
            ),
            student_pass AS (
                SELECT
                    COALESCE(sheet_id, '') AS sheet_id,
                    MAX(CASE WHEN overall_status = 'PASS' THEN 1 ELSE 0 END) AS has_pass
                FROM filtered_scans
                GROUP BY COALESCE(sheet_id, '')
            )
            SELECT
                COUNT(*) AS totalStudents,
                SUM(has_pass) AS passingStudents,
                ROUND((SUM(has_pass) * 100.0) / COUNT(*), 1) AS studentPassRate
            FROM student_pass;
        `;
        const passParams = [];
        if (quizId) passParams.push(quizId);
        if (dateFrom) passParams.push(dateFrom);
        if (endOfDay) passParams.push(endOfDay);
        if (entryType) passParams.push(entryType);
        if (equityGroup) passParams.push(equityGroup);
        const [{ totalStudents, passingStudents, studentPassRate }] = await database.query(studentPassQuery, passParams);
        const total = totalStudents;
        const passing = passingStudents;
        const failing = total - passing;
        const passRate = studentPassRate;

        // Average percentage across the filtered scans
        const avgPercentage = scans.length > 0
            ? Math.round((scans.reduce((sum, s) => sum + (Number(s.percentage) || 0), 0) / scans.length) * 10) / 10
            : 0;

        
        res.json({
            scans: scans.map(s => ({
                ...s,
                answers: JSON.parse(s.answers || '[]')
            })),
            statistics: {
                totalStudents: total,
                passingStudents: passing,
                failing,
                studentPassRate: passRate,
                avgPercentage
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Systems endpoints
router.get('/systems', authenticateToken, async (req, res) => {
    try {
        const systems = await database.query('SELECT * FROM systems ORDER BY created_at DESC');
        res.json(systems);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/systems', authenticateToken, async (req, res) => {
    try {
        const { name, description } = req.body;
        const result = await database.run(
            'INSERT INTO systems (name, description) VALUES (?, ?)',
            [name, description]
        );
        res.json({ id: result.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.delete('/systems', authenticateToken, async (req, res) => {
    try {
        await database.run('DELETE FROM systems');
        res.status(204).send();
    } catch (error) {
        sendDatabaseWriteError(res, error);
    }
});

router.get('/system/backup/history', authenticateToken, async (_req, res) => {
    try {
        const backups = listRuntimeBackupArchives().map((item) => ({
            fileName: item.fileName,
            sizeBytes: item.sizeBytes,
            modifiedAt: item.modifiedAt
        }));
        return res.json({
            success: true,
            backups
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to load backup history'
        });
    }
});

router.get('/system/backup/download', authenticateToken, async (_req, res) => {
    res.setTimeout(0);
    let backupPath = '';

    try {
        ensureBackupArchiveDir();

        const stamp = buildBackupStamp();
        const fileName = `scancheck-backup-${stamp}.zip`;
        backupPath = path.join(BACKUP_ARCHIVE_DIR, fileName);

        console.log(`[Backup] Generate backup started`);
        console.log(`[Backup] Runtime root: ${runtimePaths.runtimeRoot}`);
        console.log(`[Backup] Destination: ${backupPath}`);

        if (fs.existsSync(backupPath)) {
            fs.rmSync(backupPath, { force: true });
        }

        await createRuntimeBackupArchive(backupPath);

        if (!fs.existsSync(backupPath)) {
            throw new Error(`Backup archive was not created: ${backupPath}`);
        }

        const stat = fs.statSync(backupPath);
        if (!stat.size) {
            throw new Error(`Backup archive is empty: ${backupPath}`);
        }

        console.log(`[Backup] Archive created: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

        return res.download(backupPath, fileName, (downloadError) => {
            if (downloadError) {
                console.error(`[Backup] Download stream failed:`, downloadError);
                if (!res.headersSent) {
                    return res.status(500).json({
                        success: false,
                        error: downloadError.message || 'Failed to stream backup archive'
                    });
                }
                return;
            }

            console.log(`[Backup] Download finished: ${fileName}`);
        });
    } catch (error) {
        console.error(`[Backup] Generate failed:`, error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to generate backup archive'
        });
    }
});

// --- BACKUP REDESIGN HELPERS ---

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (_e) { /* ignore */ }
}

function safeRm(dirPath, exclude = []) {
    try {
        if (dirPath && fs.existsSync(dirPath)) {
            clearDirectoryContents(dirPath, [...exclude, 'logs', 'tmp']); // Always exclude logs and tmp
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
    } catch (_e) {
        console.warn(`[Warning] Could not fully remove ${dirPath}, but continuing...`);
        if (process.platform === 'win32' && dirPath && fs.existsSync(dirPath)) {
            try {
                const fullExclude = [...exclude, 'logs', 'tmp'];
                const excludeArgs = fullExclude.map(e => `-Exclude "${e}"`).join(' ');
                spawnSync('powershell', ['-NoProfile', '-Command', `Get-ChildItem -Path "${dirPath}" -Force ${excludeArgs} | Remove-Item -Recurse -Force`], { stdio: 'ignore' });
            } catch (__e) {
                // Ignore
            }
        }
    }
}

async function getDiskFreeSpace(dirPath) {
    try {
        if (process.platform === 'win32') {
            const drive = path.parse(path.resolve(dirPath)).root.split(':')[0];
            const script = `(Get-PSDrive -Name ${drive}).Free`;
            const { stdout } = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
            const bytes = parseInt(stdout.trim(), 10);
            return isNaN(bytes) ? Infinity : bytes;
        } else {
            const { stdout } = spawnSync('df', ['-Pk', dirPath], { encoding: 'utf8' });
            const lines = stdout.trim().split('\n');
            if (lines.length >= 2) {
                const parts = lines[1].split(/\s+/);
                const availableKB = parseInt(parts[3], 10);
                return availableKB * 1024;
            }
        }
        return Infinity;
    } catch (_e) {
        return Infinity;
    }
}

async function performAtomicRestore(archivePath, res) {
    const stamp = Date.now();
    const restoringDir = path.join(runtimePaths.repoRoot, `.runtime-restoring-${stamp}`);
    const oldRuntimeBackup = path.join(runtimePaths.repoRoot, `.runtime-before-restore-${stamp}`);
    
    const sendLog = (msg) => {
        console.log(`[Restore] ${msg}`);
        // We can't easily stream logs back in a single JSON POST response without WebSockets or SSE,
        // but we'll include the final log in the response.
    };

    try {
        // 1. Disk Space Check (Estimate: archive size * 2.5)
        const stats = fs.statSync(archivePath);
        const requiredSpace = stats.size * 2.5;
        const freeSpace = await getDiskFreeSpace(runtimePaths.repoRoot);
        
        if (freeSpace < requiredSpace) {
            throw new Error(`Insufficient disk space. Required: ${Math.round(requiredSpace / 1024 / 1024 / 1024)}GB, Available: ${Math.round(freeSpace / 1024 / 1024 / 1024)}GB`);
        }

        // 2. Extract to temp restoration folder
        sendLog(`Extracting backup to ${restoringDir}...`);
        fs.mkdirSync(restoringDir, { recursive: true });
        extractZipArchive(archivePath, restoringDir);

        // 3. Validation
        const restoredRuntime = resolveRestoredRuntimeDir(restoringDir);
        if (!restoredRuntime) {
            throw new Error('Backup archive does not contain a valid ScanCheck runtime folder.');
        }

        const dbPath = path.join(restoredRuntime, 'data', 'scancheck.db');
        if (!fs.existsSync(dbPath)) {
            throw new Error('Backup archive is missing the database (data/scancheck.db).');
        }

        // 4. Atomic Swap
        sendLog(`Closing database...`);
        await database.close();
        await new Promise(r => setTimeout(r, 1000)); // Cool down locks

        sendLog(`Swapping runtime directories...`);
        if (fs.existsSync(runtimePaths.runtimeRoot)) {
            try {
                fs.renameSync(runtimePaths.runtimeRoot, oldRuntimeBackup);
            } catch (renameErr) {
                if (process.platform === 'win32') {
                    // On Windows, rename can fail if files are locked! Skip logs/tmp in both directions!
                    sendLog(`Rename failed, trying fallback copy (skipping logs/tmp)...`);
                    safeCopyDirectory(runtimePaths.runtimeRoot, oldRuntimeBackup, ['logs', 'tmp']);
                    clearDirectoryContents(runtimePaths.runtimeRoot, ['logs', 'tmp']);
                } else {
                    throw renameErr;
                }
            }
        }
        
        try {
            fs.renameSync(restoredRuntime, runtimePaths.runtimeRoot);
        } catch (renameErr) {
            if (process.platform === 'win32') {
                sendLog(`Rename failed, trying fallback copy (skipping logs/tmp)...`);
                safeCopyDirectory(restoredRuntime, runtimePaths.runtimeRoot, ['logs', 'tmp']);
            } else {
                throw renameErr;
            }
        }

        // 5. Re-init
        sendLog(`Re-initializing database...`);
        try {
            await database.init();
        } catch (initErr) {
            sendLog(`CRITICAL: Database init failed after swap. Rolling back...`);
            // Rollback
            safeRm(runtimePaths.runtimeRoot);
            if (fs.existsSync(oldRuntimeBackup)) {
                try {
                    fs.renameSync(oldRuntimeBackup, runtimePaths.runtimeRoot);
                } catch (_err) {
                    fs.cpSync(oldRuntimeBackup, runtimePaths.runtimeRoot, { recursive: true });
                }
            }
            await database.init();
            throw new Error(`Restore failed during re-initialization: ${initErr.message}`);
        }

        // 6. Final Stats
        const [recordStats = { count: 0 }] = await database.query('SELECT COUNT(*) as count FROM records');
        const [scanStats = { count: 0 }] = await database.query('SELECT COUNT(*) as count FROM scans');

        // Cleanup
        safeRm(restoringDir);
        // We keep oldRuntimeBackup for manual recovery if needed, but for very large restores 
        // we might want to delete it if disk is low. Let's keep it for now as a safety feature.

        return res.json({
            success: true,
            message: 'Atomic restore complete.',
            restoredCounts: {
                records: Number(recordStats.count || 0),
                scans: Number(scanStats.count || 0)
            }
        });

    } catch (error) {
        sendLog(`Restore failed: ${error.message}`);
        safeRm(restoringDir);
        // Ensure DB is back up if we failed before swap
        if (!database.db) await database.init().catch(() => {});
        
        return res.status(500).json({
            success: false,
            error: error.message || 'Atomic restore failed'
        });
    }
}

// --- SYSTEM RESTORE ENDPOINT ---
router.post('/system/backup/restore', authenticateToken, async (req, res) => {
    const tempRoot = path.join(runtimePaths.tmpDir, `restore-${Date.now()}`);
    const uploadedZipPath = path.join(tempRoot, 'uploaded-backup.zip');
    const extractedPath = path.join(tempRoot, 'extracted');

    console.log(`[Restore] Starting restoration process...`);
    console.log(`[Restore] Temp Root: ${tempRoot}`);

    try {
        if (!fs.existsSync(runtimePaths.tmpDir)) {
            fs.mkdirSync(runtimePaths.tmpDir, { recursive: true });
        }
        fs.mkdirSync(tempRoot, { recursive: true });

        console.log(`[Restore] Streaming upload to disk...`);
        const bytesReceived = await streamRequestToFile(req, uploadedZipPath, MAX_BACKUP_UPLOAD_BYTES);
        console.log(`[Restore] Received ${bytesReceived} bytes.`);
        
        if (bytesReceived === 0) {
            return res.status(400).json({
                success: false,
                error: 'Backup file is empty.'
            });
        }

        if (bytesReceived < MIN_BACKUP_SIZE_BYTES) {
            return res.status(400).json({
                success: false,
                error: `Backup file too small (${bytesReceived} bytes). A valid ScanCheck backup must be at least ${MIN_BACKUP_SIZE_BYTES} bytes. The file may be corrupt or not a real backup.`
            });
        }

        // Take snapshot BEFORE closing database so DB backup works
        ensureBackupArchiveDir();
        const snapshotName = `pre-restore-${buildBackupStamp()}.zip`;
        const snapshotPath = path.join(BACKUP_ARCHIVE_DIR, snapshotName);
        await createRuntimeBackupArchive(snapshotPath);
        console.log(`[Restore] Pre-restore snapshot saved: ${snapshotName}`);

        // Close database before restore to avoid file locks and corruption
        await database.close();
        
        // Wait a small bit for locks to release
        await new Promise(resolve => setTimeout(resolve, 500));

        extractZipArchive(uploadedZipPath, extractedPath);
        if (!fs.existsSync(extractedPath)) {
            throw new Error(`Extraction failed: output directory not created at ${extractedPath}`);
        }
        console.log('[Restore] Extraction finished');
        const restoredRuntimePath = resolveRestoredRuntimeDir(extractedPath);
        if (!restoredRuntimePath) {
            throw new Error('Uploaded backup does not contain a valid ScanCheck runtime folder.');
        }

        const restoredDbPath = path.join(restoredRuntimePath, 'data', 'scancheck.db');
        if (!fs.existsSync(restoredDbPath)) {
            throw new Error('Uploaded backup does not contain data/scancheck.db.');
        }

        if (!fs.existsSync(runtimePaths.runtimeRoot)) {
            fs.mkdirSync(runtimePaths.runtimeRoot, { recursive: true });
        } else {
            clearDirectoryContents(runtimePaths.runtimeRoot, ['logs', 'tmp']);
        }

        // Copy everything except logs and tmp directories to avoid Windows file locks!
        safeCopyDirectory(restoredRuntimePath, runtimePaths.runtimeRoot, ['logs', 'tmp']);
        console.log('[Restore] Runtime restored');
        
        // Re-initialize database
        await database.init();
        console.log('[Restore] Database reinitialized');
        const [recordStats = { count: 0 }] = await database.query('SELECT COUNT(*) as count FROM records');
        const [scanStats = { count: 0 }] = await database.query('SELECT COUNT(*) as count FROM scans');

        console.log('[Restore] Restore success');
        return res.json({
            success: true,
            message: 'Backup restored successfully.',
            preRestoreSnapshot: snapshotName,
            restoredAt: new Date().toISOString(),
            restoredCounts: {
                records: Number(recordStats.count || 0),
                scans: Number(scanStats.count || 0)
            }
        });
    } catch (error) {
        if (!database.db && fs.existsSync(runtimePaths.dbPath)) {
            try {
                await database.init();
            } catch (_restoreConnectionError) {
                // Surface the original restore error below.
            }
        }

        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to restore backup'
        });
    } finally {
        try {
            if (fs.existsSync(tempRoot)) {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        } catch (_cleanupError) {
            // ignore cleanup errors
        }
    }
});

router.post('/staff/bulk', authenticateToken, async (req, res) => {
    try {
        const { users } = req.body;
        if (!Array.isArray(users) || users.length === 0) {
            return res.status(400).json({ error: 'Users array is required' });
        }
        const results = [];
        for (const u of users) {
            const username = String(u.username || '').trim();
            const password = String(u.password || 'changeme');
            if (!username) {
                results.push({ username, status: 'skipped' });
                continue;
            }
            try {
                const hashed = await bcrypt.hash(password, 10);
                const r = await database.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed]);
                results.push({ username, status: 'created', id: r.id });
            } catch (err) {
                const message = String(err?.message || '');
                if (err?.code === 'SQLITE_CONSTRAINT' || message.includes('SQLITE_CONSTRAINT') || message.includes('UNIQUE constraint failed')) {
                    results.push({ username, status: 'duplicate' });
                } else {
                    results.push({ username, status: 'error', error: message });
                }
            }
        }
        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Process and store images
async function processAndStoreImage(base64Data, studentId) {
    try {
        // Extract image data from base64
        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            throw new Error('Invalid base64 image data');
        }

        const mimeType = matches[1];
        const imageBuffer = Buffer.from(matches[2], 'base64');

        // Validate image
        if (!IMAGE_CONFIG.allowedMimeTypes.includes(mimeType)) {
            throw new Error('Invalid image type');
        }
        if (imageBuffer.length > IMAGE_CONFIG.maxFileSize) {
            throw new Error('Image too large');
        }

        // Generate filenames
        const timestamp = Date.now();
        const fileExtension = mimeType.split('/')[1];
        const filename = `scan_${studentId}_${timestamp}.${fileExtension}`;
        const thumbnailname = `thumb_${studentId}_${timestamp}.${fileExtension}`;

        const imagePath = path.join(IMAGE_CONFIG.uploadDir, filename);
        const thumbnailPath = path.join(IMAGE_CONFIG.thumbnailDir, thumbnailname);

        // Save original image
        fs.writeFileSync(imagePath, imageBuffer);

        // Create thumbnail (300x300) using Jimp
        const image = await Jimp.read(imageBuffer);
        await image.scaleToFit(300, 300)
                   .quality(80)
                   .writeAsync(thumbnailPath);

        return {
            imagePath: `/uploads/images/${filename}`,
            thumbnailPath: `/uploads/thumbnails/${thumbnailname}`,
            filename: filename,
            fileSize: imageBuffer.length,
            mimeType: mimeType
        };

    } catch (error) {
        console.error('Image processing error:', error);
        throw error;
    }
}

// Calculate subject scores
async function calculateSubjectScores(answers, quizId = null) {
    const quizRows = quizId
        ? await database.query('SELECT title, question_count, format, subject_config FROM quizzes WHERE id = ?', [quizId])
        : [];
    const quiz = quizRows[0] || {};
    const totalQuestions = Math.max(1, Math.min(100, Number.parseInt(String(quiz.question_count || answers.length || 100), 10) || 100));
    const format = quiz.format === 'normal' ? 'normal' : 'multi-subject';
    const subjects = normalizeQuizSubjectConfig(
        format,
        parseSubjectConfigValue(quiz.subject_config) || [],
        quiz.title || '',
        totalQuestions
    );
    const results = {};
    let totalScore = 0;

    let allCorrectAnswers = null;
    if (quizId) {
        allCorrectAnswers = await getCorrectAnswersForQuiz(quizId);
    }

    let cursor = 0;
    subjects.forEach((subject, index) => {
        const count = Math.max(1, Math.min(totalQuestions - cursor || totalQuestions, Number(subject.questions) || totalQuestions));
        const subjectAnswers = answers.slice(cursor, cursor + count);
        const correctAnswers = Array.isArray(allCorrectAnswers)
            ? allCorrectAnswers.slice(cursor, cursor + count)
            : [];
        let score = 0;
        for (let i = 0; i < subjectAnswers.length; i++) {
            const studentAns = String(subjectAnswers[i] || '').trim().toUpperCase();
            const correctAns = String(correctAnswers[i] || '').trim().toUpperCase();
            if (studentAns && correctAns && studentAns === correctAns) {
                score++;
            }
        }
        const percentage = count > 0 ? (score / count) * 100 : 0;
        const status = percentage >= 75 ? 'PASS' : 'FAIL';
        const keyBase = String(subject.code || subject.name || `SUB${index + 1}`).trim().toUpperCase() || `SUB${index + 1}`;
        let key = keyBase;
        let suffix = 2;
        while (results[key]) {
            key = `${keyBase}_${suffix++}`;
        }

        results[key] = {
            code: keyBase,
            name: String(subject.name || keyBase).trim().toUpperCase(),
            score,
            total: count,
            percentage: percentage.toFixed(1),
            status,
            start: cursor + 1,
            end: cursor + count
        };
        totalScore += score;
        cursor += count;
    });

    const overallPercentage = (totalScore / totalQuestions) * 100;
    const overallStatus = overallPercentage >= 75 ? 'PASS' : 'FAIL';

    return {
        ...results,
        totalScore,
        totalQuestions,
        overallPercentage: overallPercentage.toFixed(1),
        overallStatus
    };
}

function buildIncompleteSubjectScores(totalQuestions = 100) {
    const subjectCodes = ['ENG', 'SCI', 'MATH', 'GEN', 'ABS'];
    const results = {};
    subjectCodes.forEach((code) => {
        results[code] = { score: 0, total: 20, percentage: '0.0', status: 'INCOMPLETE' };
    });
    return {
        ...results,
        totalScore: 0,
        totalQuestions: Number(totalQuestions) || 100,
        overallPercentage: '0.0',
        overallStatus: 'INCOMPLETE',
        scoringStatus: 'incomplete'
    };
}

function getSubjectScoreEntry(subjectResults = {}, key) {
    const item = subjectResults[key] || {};
    return {
        score: Number(item.score) || 0,
        total: Number(item.total) || 0,
        percentage: Number.parseFloat(String(item.percentage || 0)).toFixed(1),
        status: item.status || 'INCOMPLETE'
    };
}

async function saveSubjectRecordsForScan({
    scanId,
    studentId,
    studentName,
    subjectResults,
    entryType,
    residencyType,
    equityGroup,
    roomNo,
    examDateTime
}) {
    if (!scanId || !subjectResults || typeof subjectResults !== 'object') return;
    for (const [key, result] of Object.entries(subjectResults)) {
        if (['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)) continue;
        if (!result || typeof result !== 'object') continue;
        const code = String(result.code || key).trim().toUpperCase();
        const name = String(result.name || code).trim().toUpperCase();
        const subjectInfo = await getSubjectInfo(code);
        await database.run(
            `INSERT INTO subject_records (student_id, student_name, subject_id,
             subject_code, subject_name, score, total_questions, percentage, status, scan_id,
             entry_type, residency_type, special_equity_group, room_no, seat_no, exam_date_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                studentId || 'N/A',
                studentName || 'Anonymous',
                subjectInfo.id || 0,
                code,
                name,
                Number(result.score) || 0,
                Number(result.total) || 0,
                Number.parseFloat(String(result.percentage || 0)).toFixed(1),
                result.status || 'FAIL',
                scanId,
                entryType || null,
                residencyType || null,
                equityGroup || null,
                roomNo || null,
                null,
                examDateTime || null
            ]
        );
    }
}

function buildSingleSubjectResultsFromOverall({ quizSummary = {}, score = 0, totalQuestions = 100, percentage = null, status = null }) {
    const subject = normalizeQuizSubjectConfig(
        'normal',
        quizSummary.subjectConfig || [],
        quizSummary.title || '',
        totalQuestions
    )[0];
    const total = Math.max(1, Number(totalQuestions) || Number(subject.questions) || 100);
    const numericScore = Number(score) || 0;
    const pct = Number.isFinite(Number(percentage))
        ? Number(Number(percentage).toFixed(1))
        : Number(((numericScore / total) * 100).toFixed(1));
    const finalStatus = status || (pct >= 75 ? 'PASS' : 'FAIL');
    const key = subject.code || 'EXAM';
    return {
        [key]: {
            code: key,
            name: subject.name || quizSummary.title || 'EXAM QUESTIONS',
            score: numericScore,
            total,
            percentage: pct.toFixed(1),
            status: finalStatus,
            start: 1,
            end: total
        },
        totalScore: numericScore,
        totalQuestions: total,
        overallPercentage: pct.toFixed(1),
        overallStatus: finalStatus
    };
}

let subjectScoreBackfillPromise = null;

async function backfillMissingSubjectScores() {
    const scans = await database.query(`
        SELECT id, student_id, student_name, quiz_id, answers, entry_type, residency_type,
               special_equity_group, room_no, exam_date_time, subject_scores,
               score, total_questions, percentage, status, overall_status
        FROM scans
        WHERE answers IS NOT NULL
          AND (subject_scores IS NULL OR TRIM(subject_scores) = '')
        LIMIT 500
    `);
    let updated = 0;
    for (const scan of scans) {
        let answers = [];
        try {
            const parsed = JSON.parse(scan.answers || '[]');
            answers = Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
            answers = [];
        }
        if (!answers.length) continue;
        const quizSummary = await getQuizSummary(scan.quiz_id);
        const subjectResults = quizSummary.format === 'normal'
            ? buildSingleSubjectResultsFromOverall({
                quizSummary,
                score: scan.score,
                totalQuestions: scan.total_questions || answers.length || 100,
                percentage: scan.percentage,
                status: scan.overall_status || scan.status
            })
            : await calculateSubjectScores(answers, scan.quiz_id);
        const legacyEng = getSubjectScoreEntry(subjectResults, 'ENG');
        const legacySci = getSubjectScoreEntry(subjectResults, 'SCI');
        const legacyMath = getSubjectScoreEntry(subjectResults, 'MATH');
        const legacyGen = getSubjectScoreEntry(subjectResults, 'GEN');
        const legacyAbs = getSubjectScoreEntry(subjectResults, 'ABS');
        await database.run(`
            UPDATE scans
            SET english_score = ?, english_percentage = ?, english_status = ?,
                science_score = ?, science_percentage = ?, science_status = ?,
                math_score = ?, math_percentage = ?, math_status = ?,
                general_score = ?, general_percentage = ?, general_status = ?,
                abstract_score = ?, abstract_percentage = ?, abstract_status = ?,
                score_breakdown = ?, subject_scores = ?
            WHERE id = ?
        `, [
            legacyEng.score, legacyEng.percentage, legacyEng.status,
            legacySci.score, legacySci.percentage, legacySci.status,
            legacyMath.score, legacyMath.percentage, legacyMath.status,
            legacyGen.score, legacyGen.percentage, legacyGen.status,
            legacyAbs.score, legacyAbs.percentage, legacyAbs.status,
            JSON.stringify(Object.fromEntries(Object.entries(subjectResults).filter(([key]) => !['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)).map(([key, value]) => [key, value?.score || 0]))),
            JSON.stringify(subjectResults),
            scan.id
        ]);
        await database.run('DELETE FROM subject_records WHERE scan_id = ?', [scan.id]);
        await saveSubjectRecordsForScan({
            scanId: scan.id,
            studentId: scan.student_id || 'N/A',
            studentName: scan.student_name || 'Anonymous',
            subjectResults,
            entryType: scan.entry_type || null,
            residencyType: scan.residency_type || null,
            equityGroup: scan.special_equity_group || null,
            roomNo: scan.room_no || null,
            examDateTime: scan.exam_date_time || null
        });
        updated++;
    }
    if (updated > 0) {
        console.log(`[Reports] Backfilled subject scores for ${updated} scan(s).`);
    }
    return updated;
}

async function ensureSubjectScoreBackfill() {
    if (!subjectScoreBackfillPromise) {
        subjectScoreBackfillPromise = backfillMissingSubjectScores().catch((error) => {
            console.warn('[Reports] Subject score backfill skipped:', error.message);
            return 0;
        });
    }
    return subjectScoreBackfillPromise;
}

// New endpoint: Process image on server and create scan record
router.post('/scans/process', async (req, res) => {
    try {
        return res.status(410).json({
            success: false,
            scanMode: 'ai_vision',
            code: 'LEGACY_OMR_RETIRED',
            error: 'The legacy deterministic OMR scan endpoint has been retired. Use the AI Vision scan path.'
        });

        const body = req.body || {};
        const photo = body.photo || body.image_data || body.image;
        const studentId = body.studentId || body.student_id || body.deviceId || body.device_id;
        const manualStudentName = body.studentName || body.student_name || body.full_name || body.fullName;
        const fallbackStudentName = manualStudentName || 'Android Scan';
        const quizId = body.quizId || body.quiz_id;
        let questionCount = body.questionCount || body.question_count;
        const manualEntryType = body.entryType || body.entry_type;
        const manualResidencyType = body.residencyType || body.residency_type;
        const manualEquityGroup = body.specialEquityGroup || body.special_equity_group;
        const manualRoomNo = body.roomNo || body.room_no || body.room;
        const manualCourse = body.course;
        const manualAge = body.age;
        const requestedSubjects = body.subjects;
        const rotation = Number(body.rotation) || 0;
        const threshold = body.threshold;
        let effectiveSubjects = Array.isArray(requestedSubjects) && requestedSubjects.length > 0
            ? requestedSubjects
            : [];
        
        // Get question count from quiz if not provided in request
        if (quizId) {
            try {
                const quizRows = await database.query('SELECT question_count, subject_config FROM quizzes WHERE id = ?', [quizId]);
                const quizRow = quizRows[0] || null;
                if (!questionCount) {
                    questionCount = Number(quizRow?.question_count) || 100;
                }
                if (effectiveSubjects.length === 0) {
                    effectiveSubjects = parseSubjectConfigValue(quizRow?.subject_config) || [];
                }
            } catch (err) {
                console.warn('Could not fetch quiz question count, using default 100:', err.message);
                if (!questionCount) {
                    questionCount = 100;
                }
            }
        }
        
        // Default to 100 if still not set
        if (!questionCount) {
            questionCount = 100;
        }
        
        if (!photo || !photo.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Valid image data is required' });
        }

        console.log(`Processing scan for ${fallbackStudentName}, Sheet ID: ${studentId}, Quiz ID: ${quizId}, Questions: ${questionCount}`);

        // Step 1: Extract image buffer from base64
        const matches = photo.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).json({ error: 'Invalid base64 image data' });
        }
        const imageBuffer = Buffer.from(matches[2], 'base64');
        const mimeType = matches[1];

        // Step 1.1: Store in received_papers IMMEDIATELY so it appears in web system even if OMR fails
        let initialImagePath = null;
        let queuedPaperId = null;
        try {
            const timestamp = Date.now();
            const fileExtension = mimeType.split('/')[1] || 'jpg';
            const label = String(fallbackStudentName).replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const filename = `recv_${label}_${timestamp}.${fileExtension}`;
            
            const receivedDir = runtimePaths.uploadsReceivedDir;
            if (!fs.existsSync(receivedDir)) fs.mkdirSync(receivedDir, { recursive: true });
            
            initialImagePath = `/uploads/received/${filename}`;
            const initialImageFullPath = resolveStoredImageAbsolutePath(initialImagePath);
            fs.writeFileSync(initialImageFullPath, imageBuffer);
            
            const senderIp = req.ip || req.connection?.remoteAddress || '0.0.0.0';
            const queuedPaper = await database.run(
	                'INSERT INTO received_papers (student_name, course, age, room_no, seat_no, entry_type, residency_type, equity_group, image_path, sender_ip, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	                [
	                    fallbackStudentName,
	                    manualCourse || 'Unassigned Course',
	                    manualAge || null,
	                    manualRoomNo || null,
	                    null,
                    manualEntryType || null,
                    manualResidencyType || null,
                    manualEquityGroup || null,
                    initialImagePath,
                    senderIp,
                    studentId || null
                ]
            );
            queuedPaperId = queuedPaper.id;
            console.log(`[Queue] Paper from ${fallbackStudentName} added to received_papers queue`);
        } catch (queueErr) {
            console.warn('[Queue Warning] Could not add to received_papers:', queueErr.message);
        }

        // Step 2: Process image with generated layout only.
        let omrResult;
        const qCount = Math.min(100, Math.max(1, parseInt(questionCount, 10) || 100));
        const sheetFormat = 'multi-subject';
        omrResult = await runGeneratedLayoutOmr(imageBuffer, {
            rotation,
            debug: true,
            debugRatios: true,
            threshold,
            forensicDebug: Boolean(process.env.SCANCHECK_FORENSIC_DEBUG === '1' || req.body.forensicDebug)
        });
        if (!omrResult?.success) {
            const failureResponse = buildGeneratedLayoutFailureResponse(omrResult);
            return res.status(getGeneratedLayoutFailureStatus(omrResult)).json(failureResponse);
        }
        omrResult = markGeneratedLayoutResult(omrResult);

        const processTemplateQuestionCount = Number.parseInt(
            String(
                omrResult?.templateMetrics?.effectiveQuestionCount
                || omrResult?.templateMetrics?.templateQuestionCount
                || omrResult?.answers?.length
                || qCount
            ),
            10
        ) || qCount;
        const processActiveQuestionNumbers = buildActiveQuestionNumbers(processTemplateQuestionCount, qCount, effectiveSubjects);
        omrResult = applyActiveMaskToOmrResult(omrResult, processActiveQuestionNumbers, processTemplateQuestionCount);
        {
            const guard = suppressLikelyFalsePositiveBlank(omrResult);
            omrResult = guard.result;
        }

        if (omrResult.barcodeData && Object.keys(omrResult.barcodeData).length > 0) {
            omrResult.barcodeData = normalizeQrIdentityData(omrResult.barcodeData);
            omrResult.barcodeStatus = omrResult.barcodeStatus || 'qr_success';
        }

        const processSheetValidation = validateDetectedSheet(omrResult, qCount, sheetFormat);
        if (!processSheetValidation.valid) {
            return res.status(422).json({
                success: false,
                error: processSheetValidation.error,
                details: processSheetValidation.details || null
            });
        }

        console.log(`OMR Processing complete: ${omrResult.answers.filter(a => a).length} answers detected`);

        // Step 3: Store image
        const imageData = await processAndStoreImage(photo, studentId || 'mobile');

        // Step 4: Extract student information for the permanent records table
        // Barcode data is identity-only (sheetId/studentId/examId), not bubble metadata.
        const barcodeData = omrResult.barcodeData || {};
        
        const quizSummary = await getQuizSummary(quizId);
        const qrStudentMetadata = await resolveStudentMetadataFromQr(barcodeData, quizId);

        // Final values: identity can use QR, but bubble categories must come from OMR/manual.
        const finalStudentName = firstNonPlaceholderName(
            manualStudentName,
            qrStudentMetadata.studentName,
            barcodeData.studentName
        )
            || (isPlaceholderStudentName(fallbackStudentName) ? '' : fallbackStudentName)
            || 'Anonymous';
        
        const finalStudentId = firstNonEmptyText(studentId, barcodeData.studentId, qrStudentMetadata.studentId, barcodeData.sheetId) || 'N/A';
        const finalCourse = cleanExtractedField(manualCourse || qrStudentMetadata.course || barcodeData.course || '', 'course') || null;
        const finalAge = firstNonEmptyText(manualAge, qrStudentMetadata.age, barcodeData.age) || null;
        const finalRoomNo = firstNonEmptyText(manualRoomNo, qrStudentMetadata.roomNo, barcodeData.roomNo, barcodeData.room_no) || null;
        // Entry/Equity must come from OMR bubbles (or explicit manual override), not QR/OCR text.
        const finalEntryType = manualEntryType || omrResult.entryType || null;
        const finalResidencyType = manualResidencyType || omrResult.residencyType || null;
        const finalEquityGroup = manualEquityGroup || omrResult.equityGroup || null;
        const finalSubject = null;
        const finalSection = null;

        if (queuedPaperId && (finalStudentName || finalStudentId || barcodeData.sheetId || barcodeData.examId)) {
            try {
                await database.run(
                    `UPDATE received_papers
                     SET sheet_id = COALESCE(NULLIF(sheet_id, ''), ?),
                         student_id = COALESCE(NULLIF(student_id, ''), ?),
                         exam_id = COALESCE(NULLIF(exam_id, ''), ?),
                         student_name = ?,
	                         course = ?,
	                         age = COALESCE(?, age),
	                         room_no = COALESCE(?, room_no),
	                         exam_date_time = ?
	                     WHERE id = ?`,
                    [
                        barcodeData.sheetId || null,
                        finalStudentId || null,
                        barcodeData.examId || barcodeData.exam_id || null,
                        finalStudentName,
	                        finalCourse || 'Unassigned Course',
	                        finalAge,
	                        finalRoomNo,
	                        barcodeData.dateTime || null,
	                        queuedPaperId
                    ]
                );
            } catch (queueUpdateErr) {
                console.warn('[Queue Warning] Could not update received paper identity:', queueUpdateErr.message);
            }
        }

        const dbCorrectAnswers = quizId ? await getCorrectAnswersForQuiz(quizId) : null;
        const scoringIncomplete = Boolean(quizId && (!Array.isArray(dbCorrectAnswers) || dbCorrectAnswers.length === 0));
        if (scoringIncomplete) {
            omrResult.warnings = appendUniqueWarning(omrResult, SCORING_INCOMPLETE_WARNING);
            omrResult.scoringStatus = 'incomplete';
        } else {
            omrResult.scoringStatus = quizId ? 'complete' : 'not_requested';
        }

        // Step 5: Calculate scores based on detected answers
        if (qCount === 100) {
            // Multi-subject scoring
            const subjectResults = scoringIncomplete
                ? buildIncompleteSubjectScores(qCount)
                : await calculateSubjectScores(omrResult.answers, quizId);
            
            // Use 'PASS' or 'FAIL' for overall exam status
            const status = scoringIncomplete ? 'INCOMPLETE' : (parseFloat(subjectResults.overallPercentage) >= 75 ? 'PASS' : 'FAIL');
            const responseMetadata = buildScanResponseMetadata(omrResult, omrResult.scoringStatus);
            const legacyEng = getSubjectScoreEntry(subjectResults, 'ENG');
            const legacySci = getSubjectScoreEntry(subjectResults, 'SCI');
            const legacyMath = getSubjectScoreEntry(subjectResults, 'MATH');
            const legacyGen = getSubjectScoreEntry(subjectResults, 'GEN');
            const legacyAbs = getSubjectScoreEntry(subjectResults, 'ABS');

            // Save to database
            const scanColumns = [
                'student_id', 'student_name', 'quiz_id', 'answers',
                'score', 'total_score', 'total_questions', 'percentage', 'overall_percentage', 'status', 'overall_status',
                'english_score', 'science_score', 'math_score', 'general_score', 'abstract_score',
                'english_percentage', 'science_percentage', 'math_percentage', 'general_percentage', 'abstract_percentage',
                'english_status', 'science_status', 'math_status', 'general_status', 'abstract_status',
	                'photo', 'image_path', 'thumbnail_path', 'course', 'room_no', 'seat_no', 'exam_date_time', 'score_breakdown', 'subject_scores',
                'entry_type', 'residency_type', 'special_equity_group', 'proctor_status'
            ];
            const scanValues = [
                studentId || 'N/A', finalStudentName, quizId || null, JSON.stringify(omrResult.answers),
                subjectResults.totalScore, subjectResults.totalScore, subjectResults.totalQuestions,
                subjectResults.overallPercentage, subjectResults.overallPercentage,
                status, status,
                legacyEng.score, legacySci.score, legacyMath.score,
                legacyGen.score, legacyAbs.score,
                legacyEng.percentage, legacySci.percentage, legacyMath.percentage,
                legacyGen.percentage, legacyAbs.percentage,
                legacyEng.status, legacySci.status, legacyMath.status,
                legacyGen.status, legacyAbs.status,
                photo || null, imageData?.imagePath || null, imageData?.thumbnailPath || null,
	                finalCourse, finalRoomNo, null, barcodeData.dateTime || null,
                JSON.stringify(Object.fromEntries(Object.entries(subjectResults).filter(([key]) => !['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)).map(([key, value]) => [key, value?.score || 0]))),
                JSON.stringify(subjectResults),
                finalEntryType,
                finalResidencyType,
                finalEquityGroup,
                omrResult.proctorStatus || 'Not Verified'
            ];
            const scanResult = await database.run(
                `INSERT INTO scans (${scanColumns.join(', ')}) VALUES (${scanColumns.map(() => '?').join(', ')})`,
                scanValues
            );

            await saveSubjectRecordsForScan({
                scanId: scanResult.id,
                studentId: studentId || 'N/A',
                studentName: finalStudentName,
                subjectResults,
                entryType: finalEntryType,
                residencyType: finalResidencyType,
                equityGroup: finalEquityGroup,
                roomNo: finalRoomNo,
                examDateTime: barcodeData.dateTime || null
            });

            const recordId = await createAutomaticRecord({
                studentId: finalStudentId,
                studentName: finalStudentName,
                quizId,
                quizTitle: quizSummary.title,
                score: subjectResults.totalScore,
                totalQuestions: subjectResults.totalQuestions,
                percentage: subjectResults.overallPercentage,
                status,
                entryType: finalEntryType,
                residencyType: finalResidencyType,
                equityGroup: finalEquityGroup,
                examDateTime: barcodeData.dateTime,
                subjectCode: 'ALL',
                subject: finalSubject,
                section: finalSection,
	                course: finalCourse,
	                age: finalAge,
	                roomNo: finalRoomNo,
	                answers: omrResult.answers,
                rawText: '',
                imagePath: imageData?.imagePath,
                reviewStatus: responseMetadata.reviewStatus || ((omrResult.overallConfidence || 0) >= 0.55 ? 'auto_scanned' : 'needs_review')
            });

            await removeQueuedPaper(queuedPaperId, initialImagePath);

            res.json({
                id: scanResult.id,
                recordId,
                studentId: studentId,
                studentName: finalStudentName,
	                course: finalCourse,
	                age: finalAge,
	                roomNo: finalRoomNo,
	                score: subjectResults.totalScore,
                totalScore: subjectResults.totalScore,
                totalQuestions: subjectResults.totalQuestions,
                percentage: subjectResults.overallPercentage,
                status: status,
                subjectScores: subjectResults,
                answers: omrResult.answers,
                ocrEngine: 'omr_only',
                omrEngineUsed: omrResult.omrEngineUsed || 'generated-layout',
                reviewStatus: responseMetadata.reviewStatus || ((omrResult.overallConfidence || 0) >= 0.55 ? 'auto_scanned' : 'needs_review'),
                needsReview: responseMetadata.needsReview || (omrResult.overallConfidence || 0) < 0.55,
                falsePositiveSuppressed: Boolean(omrResult.falsePositiveSuppressed),
                falsePositiveSuppressionReason: omrResult.falsePositiveSuppressionReason || '',
                warnings: responseMetadata.warnings,
                debugImagePath: responseMetadata.debugImagePath,
                barcodeData: responseMetadata.barcodeData,
                examId: responseMetadata.examId,
                scanMode: responseMetadata.scanMode,
                layoutFound: responseMetadata.layoutFound,
                layoutId: responseMetadata.layoutId,
                workerUsed: responseMetadata.workerUsed,
                layoutBubbleCount: responseMetadata.layoutBubbleCount,
                evaluatedBubbleCount: responseMetadata.evaluatedBubbleCount,
                detectedAnswerCount: responseMetadata.detectedAnswerCount,
                detectedBubbleCount: responseMetadata.detectedBubbleCount,
                mappedBubbleCount: responseMetadata.mappedBubbleCount,
                mappingConfidence: responseMetadata.mappingConfidence,
                entryGroup: responseMetadata.entryGroup,
                equityGroup: responseMetadata.equityGroup,
                scoringStatus: responseMetadata.scoringStatus,
                image: imageData,
                timestamp: new Date().toISOString(),
                processedBy: 'server'
            });

        } else {
            // Single exam scoring
            const correctAnswers = dbCorrectAnswers;
            
            let score = 0;
            if (!scoringIncomplete) {
                for (let i = 0; i < Math.min(omrResult.answers.length, correctAnswers.length); i++) {
                    const studentAns = String(omrResult.answers[i] || '').trim().toUpperCase();
                    const correctAns = String(correctAnswers[i] || '').trim().toUpperCase();
                    if (studentAns && correctAns && studentAns === correctAns) {
                        score++;
                    }
                }
            }

            const percentage = scoringIncomplete ? 0 : (score / qCount) * 100;
            const status = scoringIncomplete ? 'INCOMPLETE' : (percentage >= 75 ? 'PASS' : 'FAIL');
            const responseMetadata = buildScanResponseMetadata(omrResult, omrResult.scoringStatus);
            const subjectResults = buildSingleSubjectResultsFromOverall({
                quizSummary,
                score,
                totalQuestions: qCount,
                percentage,
                status
            });
            const singleSubjectKey = Object.keys(subjectResults).find((key) => !['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)) || 'EXAM';

            // Identify subject if possible
            let subjectInfo = null;
            if (quizId) {
                const quizRows = await database.query('SELECT subject_id FROM quizzes WHERE id = ?', [quizId]);
                if (quizRows[0]?.subject_id) {
                    const subRows = await database.query('SELECT id, code, name FROM subjects WHERE id = ?', [quizRows[0].subject_id]);
                    if (subRows.length > 0) subjectInfo = subRows[0];
                }
            }

            // Save to database
            const scanColumns = [
                'student_id', 'student_name', 'quiz_id', 'answers',
                'score', 'total_score', 'total_questions', 'percentage', 'status',
	                'photo', 'image_path', 'thumbnail_path', 'course', 'room_no', 'seat_no',
                'score_breakdown', 'subject_scores',
                'entry_type', 'special_equity_group', 'proctor_status'
            ];
            
            // Add subject specific fields if identified
            if (subjectInfo) {
                const subCode = subjectInfo.code.toLowerCase();
                if (['math', 'english', 'science', 'social', 'filipino'].some(s => subCode.includes(s))) {
                    let fieldPrefix = '';
                    if (subCode.includes('math')) fieldPrefix = 'math';
                    else if (subCode.includes('english') || subCode.includes('eng')) fieldPrefix = 'english';
                    else if (subCode.includes('science') || subCode.includes('sci')) fieldPrefix = 'science';
                    else if (subCode.includes('social') || subCode.includes('soc')) fieldPrefix = 'social';
                    else if (subCode.includes('filipino') || subCode.includes('fil')) fieldPrefix = 'filipino';

                    if (fieldPrefix) {
                        scanColumns.push(`${fieldPrefix}_score`);
                        scanColumns.push(`${fieldPrefix}_percentage`);
                        scanColumns.push(`${fieldPrefix}_status`);
                        scanColumns.push(`${fieldPrefix}_total`);
                    }
                }
            }

            const scanValues = [
                studentId || 'N/A', finalStudentName, quizId || null,
                JSON.stringify(omrResult.answers),
                score, score, qCount, percentage, status,
                photo || null, imageData?.imagePath || null, imageData?.thumbnailPath || null,
	                finalCourse, finalRoomNo, null,
                JSON.stringify({ [singleSubjectKey]: score }),
                JSON.stringify(subjectResults),
                finalEntryType,
                finalEquityGroup,
                omrResult.proctorStatus || 'Not Verified'
            ];
            
            if (subjectInfo) {
                // We added 4 columns
                scanValues.push(score);
                scanValues.push(percentage.toFixed(1));
                scanValues.push(status);
                scanValues.push(qCount);
            }

            const scanResult = await database.run(
                `INSERT INTO scans (${scanColumns.join(', ')}) VALUES (${scanColumns.map(() => '?').join(', ')})`,
                scanValues
            );

            await saveSubjectRecordsForScan({
                scanId: scanResult.id,
                studentId: studentId || 'N/A',
                studentName: finalStudentName,
                subjectResults,
                entryType: finalEntryType,
                residencyType: finalResidencyType,
                equityGroup: finalEquityGroup,
                roomNo: finalRoomNo,
                examDateTime: barcodeData.dateTime || null
            });

            const recordId = await createAutomaticRecord({
                studentId: finalStudentId,
                studentName: finalStudentName,
                quizId,
                quizTitle: quizSummary.title,
                score,
                totalQuestions: qCount,
                percentage,
                status,
                entryType: finalEntryType,
                equityGroup: finalEquityGroup,
                subject: finalSubject,
                section: finalSection,
	                course: finalCourse,
	                age: finalAge,
	                roomNo: finalRoomNo,
	                answers: omrResult.answers,
                rawText: '',
                imagePath: imageData?.imagePath,
                reviewStatus: responseMetadata.reviewStatus || ((omrResult.overallConfidence || 0) >= 0.55 ? 'auto_scanned' : 'needs_review')
            });

            await removeQueuedPaper(queuedPaperId, initialImagePath);

            res.json({
                id: scanResult.id,
                recordId,
                studentId: studentId,
                studentName: finalStudentName,
	                course: finalCourse,
	                age: finalAge,
	                roomNo: finalRoomNo,
	                score: score,
                totalQuestions: qCount,
                percentage: percentage.toFixed(1),
                status: status,
                subjectScores: subjectResults,
                answers: omrResult.answers,
                ocrEngine: 'omr_only',
                omrEngineUsed: omrResult.omrEngineUsed || 'generated-layout',
                reviewStatus: responseMetadata.reviewStatus || ((omrResult.overallConfidence || 0) >= 0.55 ? 'auto_scanned' : 'needs_review'),
                needsReview: responseMetadata.needsReview || (omrResult.overallConfidence || 0) < 0.55,
                falsePositiveSuppressed: Boolean(omrResult.falsePositiveSuppressed),
                falsePositiveSuppressionReason: omrResult.falsePositiveSuppressionReason || '',
                warnings: responseMetadata.warnings,
                debugImagePath: responseMetadata.debugImagePath,
                barcodeData: responseMetadata.barcodeData,
                examId: responseMetadata.examId,
                scanMode: responseMetadata.scanMode,
                layoutFound: responseMetadata.layoutFound,
                layoutId: responseMetadata.layoutId,
                workerUsed: responseMetadata.workerUsed,
                layoutBubbleCount: responseMetadata.layoutBubbleCount,
                evaluatedBubbleCount: responseMetadata.evaluatedBubbleCount,
                detectedAnswerCount: responseMetadata.detectedAnswerCount,
                detectedBubbleCount: responseMetadata.detectedBubbleCount,
                mappedBubbleCount: responseMetadata.mappedBubbleCount,
                mappingConfidence: responseMetadata.mappingConfidence,
                entryGroup: responseMetadata.entryGroup,
                equityGroup: responseMetadata.equityGroup,
                scoringStatus: responseMetadata.scoringStatus,
                image: imageData,
                timestamp: new Date().toISOString(),
                processedBy: 'server'
            });
        }

    } catch (error) {
        console.error('Error processing scan:', error);
        res.status(500).json({ 
            error: error.message,
            details: 'Server-side OMR processing failed. Please check image quality and try again.'
        });
    }
});

// Enhanced scan processing for 5 subjects
router.post('/scans', async (req, res) => {
    try {
        const { studentId, studentName, answers, quizId, photo, department, course, age, roomNo, entryType, specialEquityGroup } = req.body;
        const answersArr = Array.isArray(answers) ? answers : [];
        
        // Process image if provided
        let imageData = null;
        let queuedPaperId = null;
        if (photo && photo.startsWith('data:image/')) {
            imageData = await processAndStoreImage(photo, studentId);
            
            // Also add to received_papers so it appears in the web system queue
            try {
	                const queuedPaper = await database.run(
	                    'INSERT INTO received_papers (student_name, course, image_path, sender_ip, device_id, room_no, seat_no) VALUES (?, ?, ?, ?, ?, ?, ?)',
	                    [studentName || 'Android Scan', course || null, imageData.imagePath, req.ip || '0.0.0.0', studentId || null, roomNo || null, null]
	                );
                queuedPaperId = queuedPaper.id;
            } catch (recvErr) {
                console.warn('Failed to add to received_papers queue:', recvErr.message);
            }
        }

        // Calculate subject scores
        const subjectResults = await calculateSubjectScores(answersArr, quizId);
        const quizSummary = await getQuizSummary(quizId);
        
        // Terminology: PASS/FAIL for overall status
        const status = subjectResults.overallPercentage >= 75 ? 'PASS' : 'FAIL';
        const legacyEng = getSubjectScoreEntry(subjectResults, 'ENG');
        const legacySci = getSubjectScoreEntry(subjectResults, 'SCI');
        const legacyMath = getSubjectScoreEntry(subjectResults, 'MATH');
        const legacyGen = getSubjectScoreEntry(subjectResults, 'GEN');
        const legacyAbs = getSubjectScoreEntry(subjectResults, 'ABS');

        // Save to scans table
        const scanColumns = [
            'student_id', 'student_name', 'quiz_id', 'answers',
            'score', 'total_score', 'total_questions', 'percentage', 'overall_percentage', 'status', 'overall_status',
            'english_score', 'science_score', 'math_score', 'general_score', 'abstract_score',
            'english_percentage', 'science_percentage', 'math_percentage', 'general_percentage', 'abstract_percentage',
            'english_status', 'science_status', 'math_status', 'general_status', 'abstract_status',
            'photo', 'image_path', 'thumbnail_path', 'department', 'course', 'room_no', 'seat_no',
            'score_breakdown', 'subject_scores', 'entry_type', 'special_equity_group'
        ];
        const scanValues = [
            studentId || 'N/A', studentName || 'Anonymous', quizId || null, JSON.stringify(answersArr),
            subjectResults.totalScore, subjectResults.totalScore, subjectResults.totalQuestions,
            subjectResults.overallPercentage, subjectResults.overallPercentage,
            status, status,
            legacyEng.score, legacySci.score, legacyMath.score,
            legacyGen.score, legacyAbs.score,
            legacyEng.percentage, legacySci.percentage, legacyMath.percentage,
            legacyGen.percentage, legacyAbs.percentage,
            legacyEng.status, legacySci.status, legacyMath.status,
	            legacyGen.status, legacyAbs.status,
	            photo || null, imageData?.imagePath || null, imageData?.thumbnailPath || null,
	            department || null, course || null, roomNo || null, null,
            JSON.stringify(Object.fromEntries(Object.entries(subjectResults).filter(([key]) => !['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)).map(([key, value]) => [key, value?.score || 0]))),
            JSON.stringify(subjectResults),
            entryType || null,
            specialEquityGroup || null
        ];
        const scanResult = await database.run(
            `INSERT INTO scans (${scanColumns.join(', ')}) VALUES (${scanColumns.map(() => '?').join(', ')})`,
            scanValues
        );

        await saveSubjectRecordsForScan({
            scanId: scanResult.id,
            studentId: studentId || 'N/A',
            studentName: studentName || 'Anonymous',
            subjectResults,
            entryType,
            residencyType: null,
            equityGroup: specialEquityGroup,
            roomNo,
            examDateTime: null
        });

        const recordId = await createAutomaticRecord({
            studentId: studentId || 'N/A',
            studentName: studentName || 'Anonymous',
            quizId,
            quizTitle: quizSummary.title,
            score: subjectResults.totalScore,
            totalQuestions: subjectResults.totalQuestions,
            percentage: subjectResults.overallPercentage,
            status,
            entryType,
            equityGroup: specialEquityGroup,
            subjectCode: 'ALL',
            course,
            age,
            roomNo,
            answers: answersArr,
            imagePath: imageData?.imagePath || normalizeStoredImagePath(photo),
            reviewStatus: 'auto_scanned'
        });

        await removeQueuedPaper(queuedPaperId);

        res.json({
            id: scanResult.id,
            recordId,
            studentId: studentId,
            studentName: studentName,
            score: subjectResults.totalScore,
            totalScore: subjectResults.totalScore,
            totalQuestions: subjectResults.totalQuestions,
            percentage: subjectResults.overallPercentage,
            status: status,
            subjectScores: subjectResults,
            image: imageData,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error processing multi-subject scan:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to get correct answers by subject
async function getCorrectAnswersForSubject(subjectCode) {
    try {
        const subjectRows = await database.query('SELECT id FROM subjects WHERE code = ?', [subjectCode]);
        if (subjectRows.length === 0) {
            console.warn(`Subject code ${subjectCode} not found in database.`);
            return new Array(20).fill('A'); // Default fallback
        }
        
        const subjectId = subjectRows[0].id;
        const answerKeys = await database.query(
            'SELECT question_number, correct_answer FROM answer_keys WHERE subject_id = ? ORDER BY question_number ASC',
            [subjectId]
        );
        
        const answers = new Array(20).fill('');
        answerKeys.forEach(key => {
            // For subject-specific retrieval, we assume question_number is 1-20
            if (key.question_number >= 1 && key.question_number <= 20) {
                answers[key.question_number - 1] = key.correct_answer;
            }
        });

        // Fill empty answers with 'A' as fallback if some are missing
        for (let i = 0; i < answers.length; i++) {
            if (!answers[i]) answers[i] = 'A';
        }

        return answers;
    } catch (error) {
        console.error('Error in getCorrectAnswersForSubject for ${subjectCode}:', error);
        return new Array(20).fill('A');
    }
}

function getAiOmrErrorStatus(error) {
    const code = String(error?.code || '');
    if (code === 'AI_OMR_DISABLED') return 403;
    if (code === 'AI_OMR_MISSING_API_KEY' || code === 'AI_OMR_AUTH_FAILED') return 503;
    if (code === 'AI_OMR_LAYOUT_IDENTIFICATION_FAILED' || code === 'AI_OMR_LAYOUT_NOT_FOUND') return 422;
    if (code === 'AI_OMR_RATE_LIMITED') return 429;
    if (code === 'AI_OMR_TIMEOUT' || code === 'AI_OMR_PROVIDER_UNAVAILABLE') return 504;
    if (code === 'AI_OMR_INVALID_RESPONSE' || code === 'AI_OMR_MALFORMED_RESPONSE') return 502;
    return 500;
}

function sanitizeAiOmrError(error) {
    return {
        success: false,
        scanMode: 'ai_vision',
        error: error?.message || 'AI scanner failed.',
        code: error?.code || 'AI_OMR_ERROR',
        details: Array.isArray(error?.details) ? error.details : undefined
    };
}

router.get('/ai-omr/settings', authenticateToken, async (_req, res) => {
    try {
        const settings = loadAiOmrSettings(runtimePaths);
        return res.json({
            success: true,
            settings: publicAiOmrSettings(settings)
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to load AI OMR settings'
        });
    }
});

router.post('/ai-omr/settings', authenticateToken, async (req, res) => {
    try {
        const settings = saveAiOmrSettings(req.body || {}, runtimePaths);
        return res.json({
            success: true,
            settings: publicAiOmrSettings(settings)
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            error: error.message || 'Failed to save AI OMR settings'
        });
    }
});

router.post('/ai-omr/test-connection', authenticateToken, async (req, res) => {
    try {
        const body = req.body || {};
        const savedSettings = loadAiOmrSettings(runtimePaths);
        const settings = {
            ...savedSettings,
            model: body.model ? String(body.model).trim() : savedSettings.model
        };
        const provider = new GeminiProvider(settings);
        const result = await provider.testConnection();
        return res.json({
            success: true,
            status: 'connected',
            provider: 'gemini',
            model: settings.model,
            latencyMs: result.latencyMs || 0,
            message: 'Connection successful.'
        });
    } catch (error) {
        const status = getAiOmrErrorStatus(error);
        return res.status(status).json({
            success: false,
            status: 'failed',
            code: error?.code || 'AI_OMR_CONNECTION_FAILED',
            error: 'Connection failed. Check the API key, billing, or model configuration.'
        });
    }
});

router.get('/ai-omr/usage', authenticateToken, async (_req, res) => {
    try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const [today, thisMonth, allTime] = await Promise.all([
            aiUsageAggregate('timestamp >= ?', [todayStart.toISOString()]),
            aiUsageAggregate('timestamp >= ?', [monthStart.toISOString()]),
            aiUsageAggregate('1=1')
        ]);
        return res.json({
            success: true,
            usage: {
                today,
                thisMonth,
                allTime,
                pricingAvailable: false
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: 'Could not load AI usage metrics.'
        });
    }
});

router.post('/ai-omr/identify-layout', authenticateToken, async (req, res) => {
    try {
        const body = req.body || {};
        const imagePayload = body.image || body.photo || body.image_data;
        if (!imagePayload) {
            return res.status(400).json({
                success: false,
                code: 'AI_OMR_INVALID_IMAGE',
                error: 'The uploaded image could not be processed.'
            });
        }
        let imageBuffer;
        try {
            imageBuffer = readImagePayload(imagePayload);
        } catch (_error) {
            return res.status(400).json({
                success: false,
                code: 'AI_OMR_INVALID_IMAGE',
                error: 'The uploaded image could not be processed.'
            });
        }
        const questionCount = Number.parseInt(String(body.questionCount || body.question_count || 100), 10) || 100;
        const layoutIdentity = await identifyLayoutForAiScan({
            imageBuffer,
            body,
            questionCount,
            subjects: body.subjects
        });
        if (!layoutIdentity.layoutId) {
            return res.status(422).json({
                success: false,
                code: 'AI_OMR_LAYOUT_IDENTIFICATION_FAILED',
                error: 'Could not identify sheet layout.',
                barcodeStatus: layoutIdentity.qr?.status || 'qr_not_found',
                requiresManualOverride: true
            });
        }
        const summary = await quizSummaryForLayout(layoutIdentity.layoutId, body.quizId || body.quiz_id || null);
        return res.json({
            success: true,
            layoutId: layoutIdentity.layoutId,
            examId: layoutIdentity.layoutId,
            quizId: summary.quizId,
            examName: summary.examName,
            questionCount: summary.questionCount || questionCount,
            barcodeStatus: layoutIdentity.qr?.status || 'layout_supplied',
            detectedFromQr: Boolean(layoutIdentity.qr?.success),
            layoutSource: layoutIdentity.layoutSource || (layoutIdentity.qr?.success ? 'qr' : 'manual_or_selected_exam')
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            code: 'AI_OMR_IDENTIFY_FAILED',
            error: 'Could not identify sheet layout.'
        });
    }
});

async function loadGeneratedLayoutForAiScan(layoutId) {
    const layoutPath = getLayoutPathForExamId(layoutId);
    if (!layoutPath || !fs.existsSync(layoutPath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
}

function normalizeLayoutSubjectConfig(subjects = []) {
    if (!Array.isArray(subjects)) return [];
    return subjects
        .map((subject) => {
            const questions = Array.isArray(subject?.questions)
                ? subject.questions.length
                : Number(subject?.questions || subject?.questionCount || subject?.question_count || 0);
            return {
                code: String(subject?.code || subject?.subjectCode || subject?.name || '').trim().toUpperCase(),
                name: String(subject?.name || subject?.code || subject?.subjectCode || '').trim().toUpperCase(),
                questions: Number(questions) || 0
            };
        })
        .filter((subject) => subject.questions > 0);
}

function layoutSubjectConfig(layout = {}) {
    if (Array.isArray(layout.subjectConfig)) return normalizeLayoutSubjectConfig(layout.subjectConfig);
    if (Array.isArray(layout.subject_config)) return normalizeLayoutSubjectConfig(layout.subject_config);
    if (Array.isArray(layout.subjects)) return normalizeLayoutSubjectConfig(layout.subjects);
    return [];
}

function subjectConfigsMatch(a = [], b = []) {
    const left = normalizeLayoutSubjectConfig(a);
    const right = normalizeLayoutSubjectConfig(b);
    if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
    return left.every((subject, index) => {
        const other = right[index];
        return subject.questions === other.questions
            && subject.code === other.code
            && subject.name === other.name;
    });
}

function layoutTotalQuestionCount(layout = {}) {
    const fromSubjects = layoutSubjectConfig(layout).reduce((sum, subject) => sum + subject.questions, 0);
    return Number(layout.questionCount || layout.question_count || fromSubjects || 0);
}

async function resolveGeneratedLayoutIdForSelectedQuiz(quizId, requestContext = {}) {
    if (!quizId) return null;

    let questionCount = Number(requestContext.questionCount) || 0;
    let subjects = normalizeLayoutSubjectConfig(requestContext.subjects);
    try {
        const rows = await database.query('SELECT question_count, subject_config FROM quizzes WHERE id = ?', [quizId]);
        const row = rows[0] || null;
        questionCount = Number(row?.question_count) || questionCount;
        const dbSubjects = normalizeLayoutSubjectConfig(parseSubjectConfigValue(row?.subject_config) || []);
        if (dbSubjects.length > 0) subjects = dbSubjects;
    } catch (error) {
        console.warn('[AI OMR] Could not resolve quiz layout context:', error.message);
    }

    if (!questionCount || subjects.length === 0 || !fs.existsSync(runtimePaths.omrLayoutsDir)) return null;

    const candidates = [];
    for (const fileName of fs.readdirSync(runtimePaths.omrLayoutsDir)) {
        if (!fileName.endsWith('.json')) continue;
        const layoutPath = path.join(runtimePaths.omrLayoutsDir, fileName);
        try {
            const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
            if (layoutTotalQuestionCount(layout) !== questionCount) continue;
            if (!subjectConfigsMatch(subjects, layoutSubjectConfig(layout))) continue;
            const layoutId = String(layout.examId || layout.exam_id || path.basename(fileName, '.json')).trim();
            if (!layoutId) continue;
            const timestamp = Date.parse(layout.savedAt || layout.generatedAt || '') || fs.statSync(layoutPath).mtimeMs || 0;
            candidates.push({ layoutId, timestamp });
        } catch (_error) {
            // Ignore malformed historical layout files.
        }
    }

    candidates.sort((a, b) => b.timestamp - a.timestamp || a.layoutId.localeCompare(b.layoutId));
    return candidates[0]?.layoutId || null;
}

async function identifyLayoutForAiScan({ imageBuffer, body = {}, questionCount, subjects }) {
    const suppliedLayoutId = body.layoutId || body.layout_id || body.examId || body.exam_id || null;
    const identity = await identifyLayout({ imageBuffer, suppliedLayoutId });
    if (identity.layoutId) return identity;

    const fallbackLayoutId = await resolveGeneratedLayoutIdForSelectedQuiz(body.quizId || body.quiz_id || null, {
        questionCount,
        subjects
    });
    if (!fallbackLayoutId) return identity;

    return {
        layoutId: fallbackLayoutId,
        qr: {
            ...(identity.qr || {}),
            success: false,
            status: 'qr_failed_layout_from_selected_exam',
            barcodeData: null
        },
        layoutSource: 'selected_exam_latest_compatible_layout'
    };
}

async function buildAiOmrScoring(scanResult, quizId) {
    if (!quizId) {
        return { scoringStatus: 'not_requested' };
    }
    const dbCorrectAnswers = await getCorrectAnswersForQuiz(quizId);
    if (!Array.isArray(dbCorrectAnswers) || dbCorrectAnswers.length === 0) {
        return {
            scoringStatus: 'incomplete',
            warning: SCORING_INCOMPLETE_WARNING
        };
    }
    return {
        scoringStatus: 'complete',
        subjectResults: await calculateSubjectScores(scanResult.answers, quizId)
    };
}

async function quizSummaryForLayout(layoutId, quizId = null) {
    const layout = layoutId ? await loadGeneratedLayoutForAiScan(layoutId) : null;
    const resolvedQuizId = quizId || layout?.quizId || layout?.quiz_id || null;
    let quiz = null;
    if (resolvedQuizId) {
        const rows = await database.query('SELECT id, title, question_count, subject_config FROM quizzes WHERE id = ?', [resolvedQuizId]);
        quiz = rows[0] || null;
    }
    const questionCount = Number(quiz?.question_count || layoutTotalQuestionCount(layout || {}) || layout?.questionCount || layout?.question_count || 0) || null;
    return {
        layout,
        quizId: quiz?.id || resolvedQuizId || null,
        examName: quiz?.title || layout?.title || layout?.examName || layout?.exam_name || layoutId || '',
        questionCount
    };
}

function aiOmrUsagePayload(scanResult = {}, extra = {}) {
    const metrics = scanResult.metrics || {};
    const usage = metrics.tokenUsage || {};
    return {
        requestId: scanResult.requestId || extra.requestId || null,
        layoutId: scanResult.layoutId || extra.layoutId || null,
        examId: extra.examId || scanResult.layoutId || null,
        provider: scanResult.provider || extra.provider || 'gemini',
        model: scanResult.model || extra.model || null,
        strategy: scanResult.strategy || extra.strategy || null,
        questionCount: Number(metrics.totalQuestions || extra.questionCount || 0) || null,
        requestCount: Number(metrics.apiCallCount || extra.requestCount || 0) || null,
        inputTokens: Number.isFinite(Number(usage.inputTokens)) ? Number(usage.inputTokens) : null,
        outputTokens: Number.isFinite(Number(usage.outputTokens)) ? Number(usage.outputTokens) : null,
        totalTokens: Number.isFinite(Number(usage.totalTokens)) ? Number(usage.totalTokens) : null,
        thoughtsTokens: Number.isFinite(Number(usage.thoughtsTokens)) ? Number(usage.thoughtsTokens) : null,
        processingTimeMs: Number(metrics.latencyMs || extra.processingTimeMs || 0) || null,
        reviewCount: Array.isArray(scanResult.needsReview) ? scanResult.needsReview.length : Number(extra.reviewCount || 0),
        success: scanResult.success !== false,
        errorCode: extra.errorCode || null
    };
}

async function recordAiOmrUsage(usage = {}) {
    try {
        await database.run(
            `INSERT INTO ai_omr_usage (
                request_id, layout_id, exam_id, provider, model, strategy,
                question_count, request_count, input_tokens, output_tokens, total_tokens, thoughts_tokens,
                processing_time_ms, review_count, success, error_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                usage.requestId || null,
                usage.layoutId || null,
                usage.examId || null,
                usage.provider || null,
                usage.model || null,
                usage.strategy || null,
                usage.questionCount || null,
                usage.requestCount || null,
                usage.inputTokens,
                usage.outputTokens,
                usage.totalTokens,
                usage.thoughtsTokens,
                usage.processingTimeMs || null,
                usage.reviewCount || 0,
                usage.success ? 1 : 0,
                usage.errorCode || null
            ]
        );
    } catch (error) {
        console.warn('[AI Usage] Could not record usage:', error.message);
    }
}

async function aiUsageAggregate(whereSql, params = []) {
    const rows = await database.query(
        `SELECT
            COUNT(*) AS papers,
            COALESCE(SUM(request_count), 0) AS requests,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            COALESCE(SUM(total_tokens), 0) AS totalTokens,
            COALESCE(SUM(thoughts_tokens), 0) AS thoughtsTokens,
            COALESCE(AVG(processing_time_ms), 0) AS averageProcessingMs,
            COALESCE(AVG(request_count), 0) AS averageRequests
         FROM ai_omr_usage
         WHERE ${whereSql}`,
        params
    );
    const row = rows[0] || {};
    return {
        papers: Number(row.papers || 0),
        requests: Number(row.requests || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        totalTokens: Number(row.totalTokens || 0),
        thoughtsTokens: Number(row.thoughtsTokens || 0),
        averageProcessingMs: Math.round(Number(row.averageProcessingMs || 0)),
        averageRequests: Math.round(Number(row.averageRequests || 0) * 10) / 10
    };
}

// AI Vision OMR endpoint. This does not call the legacy contour answer classifier.
router.post('/ai-omr/scan', authenticateToken, async (req, res) => {
    try {
        const body = req.body || {};
        const imagePayload = body.image || body.photo || body.image_data;
        if (!imagePayload) {
            return res.status(400).json({
                success: false,
                scanMode: 'ai_vision',
                error: 'Image data is required.',
                code: 'AI_OMR_INVALID_IMAGE'
            });
        }

        const imageBuffer = readImagePayload(imagePayload);
        const mimeType = inferImageMimeType(imagePayload);
        const layoutIdentity = await identifyLayoutForAiScan({
            imageBuffer,
            body,
            questionCount: body.questionCount || body.question_count,
            subjects: body.subjects
        });
        if (!layoutIdentity.layoutId) {
            return res.status(422).json({
                success: false,
                scanMode: 'ai_vision',
                error: 'Layout identification failed. QR could not be decoded and no layoutId was supplied.',
                code: 'AI_OMR_LAYOUT_IDENTIFICATION_FAILED',
                barcodeStatus: layoutIdentity.qr?.status || 'qr_not_found'
            });
        }

        const layout = await loadGeneratedLayoutForAiScan(layoutIdentity.layoutId);
        if (!layout) {
            return res.status(404).json({
                success: false,
                scanMode: 'ai_vision',
                error: 'Generated layout was not found.',
                code: 'AI_OMR_LAYOUT_NOT_FOUND',
                layoutId: layoutIdentity.layoutId
            });
        }

        const baseOptions = {
            imageBuffer,
            mimeType,
            layout,
            layoutId: layoutIdentity.layoutId,
            requestId: body.requestId || body.request_id || null,
            strategy: body.strategy || undefined,
            verifyLowConfidence: Boolean(body.verifyLowConfidence || body.verify_low_confidence),
            groundTruthAnswers: body.groundTruthAnswers || body.ground_truth_answers || null,
            runtimePaths,
            config: loadAiOmrSettings(runtimePaths)
        };

        if (body.benchmark === true) {
            const benchmark = await runAiOmrBenchmark({
                ...baseOptions,
                repeat: Math.max(1, Math.min(3, Number(body.repeat) || 3))
            });
            return res.json({
                success: true,
                scanMode: 'ai_vision',
                provider: benchmark.runs[0]?.provider || 'gemini',
                model: benchmark.runs[0]?.model || process.env.AI_OMR_MODEL || 'gemini-3.6-flash',
                layoutId: layoutIdentity.layoutId,
                benchmark
            });
        }

        const scanResult = await runAiOmrScan(baseOptions);
        await recordAiOmrUsage(aiOmrUsagePayload(scanResult, {
            examId: layoutIdentity.layoutId,
            questionCount: layoutTotalQuestionCount(layout || {})
        }));
        const scoring = await buildAiOmrScoring(scanResult, body.quizId || body.quiz_id || null);
        return res.json({
            ...scanResult,
            scoringStatus: scoring.scoringStatus,
            scoringWarning: scoring.warning || null,
            subjectResults: scoring.subjectResults || null
        });
    } catch (error) {
        const status = getAiOmrErrorStatus(error);
        await recordAiOmrUsage({
            requestId: req.body?.requestId || req.body?.request_id || null,
            layoutId: req.body?.layoutId || req.body?.layout_id || null,
            examId: req.body?.examId || req.body?.exam_id || null,
            provider: 'gemini',
            model: loadAiOmrSettings(runtimePaths).model,
            success: false,
            errorCode: error?.code || 'AI_OMR_ERROR'
        });
        if (status >= 500) {
            console.warn('[AI OMR] Scan failed:', error?.code || error?.message || error);
        }
        return res.status(status).json(sanitizeAiOmrError(error));
    }
});

// OMR Extraction Endpoint
router.post('/omr/layouts', authenticateToken, async (req, res) => {
    try {
        const layout = normalizeGeneratedLayoutPayload(req.body || {});
        console.log(`[OMR Layout] requested examId=${layout.examId}`);
        const layoutPath = getLayoutPathForExamId(layout.examId);
        if (!layoutPath) {
            return res.status(400).json({ success: false, error: 'Invalid examId' });
        }
        if (!fs.existsSync(runtimePaths.omrLayoutsDir)) {
            fs.mkdirSync(runtimePaths.omrLayoutsDir, { recursive: true });
        }
        // Preserve historical V1/V2 layouts: a new generation must use a fresh
        // examId rather than overwriting a stored layout that resolves to a
        // different (older) layout version. Existing physical sheets keep their
        // original stored geometry this way.
        if (fs.existsSync(layoutPath)) {
            let storedVersion = null;
            try {
                storedVersion = String(JSON.parse(fs.readFileSync(layoutPath, 'utf8')).layoutVersion || 'generated-layout-v1');
            } catch (_error) {
                storedVersion = null;
            }
            if (storedVersion && storedVersion !== layout.layoutVersion) {
                return res.status(409).json({
                    success: false,
                    error: `Refusing to overwrite stored layout for examId=${layout.examId} (version ${storedVersion}) with a different version (${layout.layoutVersion}). Regenerate the sheet to obtain a fresh examId so historical layouts remain valid.`
                });
            }
        }
        console.log(`[OMR Layout] saved path=${layoutPath}`);
        fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2), 'utf8');
        
        // Verify the file was saved correctly
        const exists = fs.existsSync(layoutPath);
        console.log(`[OMR Layout] exists=${exists}`);
        if (!exists) {
            return res.status(500).json({
                success: false,
                error: 'Layout saving failed. This sheet cannot be scanned.'
            });
        }
        
        return res.json({
            success: true,
            examId: layout.examId,
            exam_id: layout.exam_id,
            layoutPath: `/omr-layouts/${path.basename(layoutPath)}`,
            sheetSize: layout.sheetSize
        });
    } catch (error) {
        console.error('[OMR Layout] Error:', error);
        return res.status(400).json({
            success: false,
            error: error.message || 'Failed to save generated OMR layout'
        });
    }
});

router.get('/omr/layouts/:examId', authenticateToken, async (req, res) => {
    try {
        const layoutPath = getLayoutPathForExamId(req.params.examId);
        if (!layoutPath || !fs.existsSync(layoutPath)) {
            return res.status(404).json({ success: false, error: 'Generated layout not found' });
        }
        const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
        return res.json({ success: true, layout });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message || 'Failed to load generated OMR layout'
        });
    }
});

router.post('/omr/debug-bubbles', authenticateToken, async (req, res) => {
    try {
        return res.status(410).json({
            success: false,
            code: 'LEGACY_OMR_DEBUG_RETIRED',
            error: 'Legacy bubble debug scanning has been retired from the product path.'
        });

        const imagePayload = req.body?.image || req.body?.photo || req.body?.image_data;
        const examId = req.body?.examId || req.body?.exam_id || null;
        const imageBuffer = readImagePayload(imagePayload);
        const detectorResult = await runFilledCircleDetector(imageBuffer, examId);

        return res.json({
            success: true,
            count: detectorResult.count,
            bubbles: detectorResult.bubbles,
            rows: Array.isArray(detectorResult.rows) ? detectorResult.rows : [],
            questions: Array.isArray(detectorResult.questions) ? detectorResult.questions : [],
            mappedAnswers: detectorResult.mappedAnswers || null,
            mappedBubbles: Array.isArray(detectorResult.mappedBubbles) ? detectorResult.mappedBubbles : [],
            image_width: detectorResult.image_width || null,
            image_height: detectorResult.image_height || null,
            debug_image_url: detectorResult.debug_image_url,
            threshold_image_url: detectorResult.threshold_image_url
        });
    } catch (error) {
        const status = /image data|payload|decode|not found/i.test(error.message || '') ? 400 : 500;
        return res.status(status).json({
            success: false,
            error: error.message || 'Failed to run bubble debug detector'
        });
    }
});

// AI Vision extraction endpoint
router.post('/ocr', authenticateToken, async (req, res) => {
    try {
        const requestId = crypto.randomUUID();
        const workerStartedAt = new Date().toISOString();
        const { 
            photo, 
            quizId, 
            sourceReceivedPaperId, 
            rotation = 0, 
            debug = false,
            threshold,
            subjects: requestedSubjects,
            manualName,
            manualAge,
            manualCourse,
            manualRoom,
            manualEntry,
            manualResidency,
            manualEquity
        } = req.body;
        const sheetFormat = normalizeSheetFormat(req.body.sheetFormat);
        if (!photo) return res.status(400).json({ error: 'Image data is required' });

        console.log(`Starting AI Vision extraction (rotation: ${rotation}, sheet format: ${sheetFormat})...`);

        // Extract image buffer from base64 or file path
        let imageBuffer;
        let photoPath = photo;

        // If it's a URL, convert to local path
        if (typeof photoPath === 'string' && photoPath.includes('/api/uploads/')) {
            photoPath = photoPath.replace(/.*\/api\/uploads\//, '/uploads/');
        }

        if (typeof photoPath === 'string' && photoPath.startsWith('data:image/')) {
            const matches = photoPath.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (!matches || matches.length !== 3) {
                return res.status(400).json({ error: 'Invalid base64 image data' });
            }
            imageBuffer = Buffer.from(matches[2], 'base64');
        } else {
            // Assume it's a file path if not base64
            if (fs.existsSync(photoPath)) {
                imageBuffer = fs.readFileSync(photoPath);
            } else {
                // Try relative to project root if it looks like a relative path
                const absolutePath = resolveStoredImageAbsolutePath(photoPath);
                if (absolutePath && fs.existsSync(absolutePath)) {
                    imageBuffer = fs.readFileSync(absolutePath);
                } else {
                    return res.status(400).json({ error: 'Image file not found: ' + photoPath });
                }
            }
        }

        // Compute image hash from the actual buffer sent to AI Vision.
        const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
        console.log(`[ocr] requestId=${requestId} imageHash=${imageHash.slice(0, 12)} size=${imageBuffer.length} examId=${req.body.quizId || '?'} sheetFormat=${sheetFormat}`);

        // Run AI Vision answer reading only.
        let omrResult;
        let questionCount = Number.parseInt(String(req.body.questionCount || req.body.question_count || 100), 10) || 100;
        let effectiveSubjects = Array.isArray(requestedSubjects) && requestedSubjects.length > 0
            ? requestedSubjects
            : [];
        
        // Get question count from quiz if available
        if (quizId) {
            try {
                const quizRows = await database.query('SELECT question_count, subject_config FROM quizzes WHERE id = ?', [quizId]);
                const quizRow = quizRows[0] || null;
                questionCount = Number(quizRow?.question_count) || 100;
                if (effectiveSubjects.length === 0) {
                    effectiveSubjects = parseSubjectConfigValue(quizRow?.subject_config) || [];
                }
            } catch (err) {
                console.warn('Could not fetch quiz question count, using default 100:', err.message);
            }
        }
        questionCount = Math.min(100, Math.max(1, Number(questionCount) || 100));

        const aiSettings = {
            ...loadAiOmrSettings(runtimePaths),
            enabled: true
        };
        if (aiSettings.enabled) {
            const layoutIdentity = await identifyLayoutForAiScan({
                imageBuffer,
                body: req.body || {},
                questionCount,
                subjects: effectiveSubjects
            });
            if (!layoutIdentity.layoutId) {
                return res.status(422).json({
                    success: false,
                    scanMode: 'ai_vision',
                    layoutFound: false,
                    requiresLayout: true,
                    error: 'Layout identification failed. QR could not be decoded and no layoutId was supplied.'
                });
            }

            const layout = await loadGeneratedLayoutForAiScan(layoutIdentity.layoutId);
            if (!layout) {
                return res.status(404).json({
                    success: false,
                    scanMode: 'ai_vision',
                    layoutFound: false,
                    requiresLayout: true,
                    layoutId: layoutIdentity.layoutId,
                    examId: layoutIdentity.layoutId,
                    error: 'Generated layout was not found.'
                });
            }

            let aiResult;
            try {
                aiResult = await runAiOmrScan({
                    imageBuffer,
                    mimeType: inferImageMimeType(photo),
                    layout,
                    layoutId: layoutIdentity.layoutId,
                    requestId,
                    strategy: aiSettings.sectionSize === 10 ? 'section_10' : 'section_20',
                    verifyLowConfidence: true,
                    runtimePaths,
                    config: aiSettings
                });
            } catch (aiError) {
                const status = getAiOmrErrorStatus(aiError);
                await recordAiOmrUsage({
                    requestId,
                    layoutId: layoutIdentity.layoutId,
                    examId: layoutIdentity.layoutId,
                    provider: 'gemini',
                    model: aiSettings.model,
                    strategy: aiSettings.strategy,
                    questionCount,
                    success: false,
                    errorCode: aiError?.code || 'AI_OMR_ERROR'
                });
                if (aiError?.details) {
                    console.warn('[AI OMR] Failure details:', JSON.stringify(aiError.details).slice(0, 1600));
                }
                return res.status(status).json(sanitizeAiOmrError(aiError));
            }
            const workerFinishedAt = new Date().toISOString();

            const barcodeData = normalizeQrIdentityData(
                layoutIdentity.qr?.barcodeData
                || aiResult.barcodeData
                || {}
            );
            const qrStudentMetadata = await resolveStudentMetadataFromQr(barcodeData, quizId);
            const resolvedStudentName = firstNonPlaceholderName(
                manualName,
                qrStudentMetadata.studentName,
                barcodeData.studentName
            ) || '';
            const resolvedSheetId = firstNonEmptyText(
                barcodeData.sheetId,
                barcodeData.sheet_id,
                qrStudentMetadata.sheetId
            );
            const resolvedCourse = cleanExtractedField(
                manualCourse || qrStudentMetadata.course || barcodeData.course || '',
                'course'
            );
            const resolvedAge = firstNonEmptyText(manualAge, qrStudentMetadata.age, barcodeData.age);
            const resolvedRoomNo = firstNonEmptyText(manualRoom, qrStudentMetadata.roomNo, barcodeData.roomNo, barcodeData.room_no);
            const resolvedDateTime = barcodeData.dateTime || barcodeData.date_time || qrStudentMetadata.dateTime || '';
            const topFields = aiResult.topFields || {};
            const topFieldValue = (fieldName) => {
                const field = topFields[fieldName] || {};
                const value = String(field.value || '').trim();
                const state = String(field.state || '').trim().toLowerCase();
                if (value) return value;
                if (state === 'multiple') return 'Multiple';
                if (state === 'uncertain') return 'Uncertain';
                if (fieldName === 'equityGroup' && state === 'blank') return 'None';
                return '';
            };
            const resolvedSex = firstNonEmptyText(
                barcodeData.sex,
                barcodeData.gender,
                topFieldValue('sex')
            );
            const resolvedEntryType = firstNonEmptyText(
                manualEntry,
                barcodeData.entryType,
                barcodeData.entry_type,
                topFieldValue('studentType')
            );
            const resolvedResidencyType = firstNonEmptyText(
                manualResidency,
                barcodeData.residencyType,
                barcodeData.residency_type,
                topFieldValue('residencyType')
            );
            const resolvedEquityGroup = firstNonEmptyText(
                manualEquity,
                barcodeData.equityGroup,
                barcodeData.equity_group,
                topFieldValue('equityGroup')
            );

            let score = 0;
            let correctAnswers = [];
            let scoringStatus = quizId ? 'complete' : 'not_requested';
            if (quizId) {
                correctAnswers = await getCorrectAnswersForQuiz(quizId);
                if (correctAnswers && correctAnswers.length > 0) {
                    for (let i = 0; i < Math.min(aiResult.answers.length, correctAnswers.length); i++) {
                        const studentAns = String(aiResult.answers[i] || '').trim().toUpperCase();
                        const correctAns = String(correctAnswers[i] || '').trim().toUpperCase();
                        if (studentAns && correctAns && studentAns === correctAns) {
                            score++;
                        }
                    }
                } else {
                    correctAnswers = [];
                    scoringStatus = 'incomplete';
                }
            } else {
                score = aiResult.answers.filter(Boolean).length;
            }

            const stateCounts = aiResult.metrics?.stateCounts || {};
            const selectedCount = Number(stateCounts.selected || 0);
            const returnedCount = Number(aiResult.metrics?.returnedQuestions || aiResult.questions?.length || 0);
            const confidence = returnedCount > 0 ? selectedCount / returnedCount : 0;
            const mappedBubbleCount = returnedCount - Number(stateCounts.uncertain || 0);
            await recordAiOmrUsage(aiOmrUsagePayload(aiResult, {
                examId: layoutIdentity.layoutId,
                questionCount
            }));

            return res.json({
                success: true,
                requestId,
                imageHash,
                imageSizeBytes: imageBuffer.length,
                workerStartedAt,
                workerFinishedAt,
                source: 'ai_vision_scan',
                cacheHit: false,
                studentName: resolvedStudentName,
                sheetId: resolvedSheetId,
                sheet_id: resolvedSheetId,
                studentId: null,
                course: resolvedCourse,
                age: resolvedAge,
                roomNo: resolvedRoomNo,
                dateTime: resolvedDateTime,
                sex: resolvedSex,
                entryType: resolvedEntryType,
                residencyType: resolvedResidencyType,
                equityGroup: resolvedEquityGroup,
                entryGroup: {
                    studentType: resolvedEntryType,
                    residencyType: resolvedResidencyType,
                    fields: topFields
                },
                equityGroupResult: {
                    value: resolvedEquityGroup || 'None',
                    values: resolvedEquityGroup && !['None', 'Multiple', 'Uncertain'].includes(resolvedEquityGroup) ? [resolvedEquityGroup] : [],
                    state: topFields.equityGroup?.state || null,
                    fields: topFields
                },
                topFields,
                classificationFields: topFields,
                barcodeData,
                barcodeStatus: layoutIdentity.qr?.status || aiResult.barcodeStatus || 'qr_success',
                proctorStatus: 'Not Verified',
                answers: aiResult.answers,
                correctAnswers,
                score,
                scoringStatus,
                confidence,
                overallConfidence: confidence,
                detectionCoverage: confidence,
                scanQualityConfidence: confidence,
                alignmentConfidence: null,
                templateMetrics: aiResult.metrics,
                questionMetrics: aiResult.questions || [],
                aiInputPreview: aiResult.metrics?.aiInputPreview || null,
                provider: aiResult.provider || 'gemini',
                model: aiResult.model || null,
                strategy: aiResult.strategy || null,
                imageDetail: aiResult.imageDetail || null,
                verificationMode: aiResult.verificationMode || null,
                promptVersion: aiResult.promptVersion || null,
                activeQuestionNumbers: (aiResult.questions || []).map((question) => question.question),
                activeQuestionCount: returnedCount,
                totalTemplateQuestions: questionCount,
                omrEngineUsed: 'gemini_vision',
                scanMode: 'ai_vision',
                layoutFound: true,
                layoutId: aiResult.layoutId,
                examId: aiResult.layoutId,
                workerUsed: 'gemini_vision',
                layoutBubbleCount: questionCount * 4,
                evaluatedBubbleCount: questionCount * 4,
                detectedAnswerCount: selectedCount,
                detectedBubbleCount: selectedCount,
                mappedBubbleCount,
                mappingConfidence: confidence,
                reviewStatus: aiResult.status === 'REVIEW' ? 'needs_review' : 'auto_scanned',
                needsReview: Array.isArray(aiResult.needsReview) ? aiResult.needsReview : [],
                needsReviewCount: Array.isArray(aiResult.needsReview) ? aiResult.needsReview.length : 0,
                warnings: scoringStatus === 'incomplete' ? [SCORING_INCOMPLETE_WARNING] : [],
                rawText: '',
                extractedDate: '',
                fieldConfidence: {},
                fieldDebug: null,
                ocrEngine: 'ai_vision',
                imagePath: typeof photo === 'string' && !photo.startsWith('data:image/') ? photo : null,
                debugImagePath: null,
                sourceReceivedPaperId: sourceReceivedPaperId || null,
                studentLookupSource: qrStudentMetadata.source || null,
                quizId,
                message: 'AI Vision scan completed successfully'
            });
        }

        return res.status(503).json({
            success: false,
            scanMode: 'ai_vision',
            code: 'AI_OMR_REQUIRED',
            error: 'AI Vision scanner is required and no legacy scanner fallback is available.'
        });
        
        omrResult = await runGeneratedLayoutOmr(imageBuffer, {
            rotation,
            debug: true,
            debugProblemQuestions: true,
            debugRatios: true,
            threshold,
            requestId,
            scanId: req.body.scanId,
            scanFile: req.body.imageFileName || req.body.filename || null,
            forensicDebug: Boolean(process.env.SCANCHECK_FORENSIC_DEBUG === '1' || req.body.forensicDebug)
        });
        const workerFinishedAt = new Date().toISOString();
        if (!omrResult?.success) {
            const failureResponse = buildGeneratedLayoutFailureResponse(omrResult);
            return res.status(getGeneratedLayoutFailureStatus(omrResult)).json(failureResponse);
        }
        omrResult = markGeneratedLayoutResult(omrResult);

        const rawTemplateQuestionCount = Number.parseInt(
            String(
                omrResult?.templateMetrics?.effectiveQuestionCount
                || omrResult?.templateMetrics?.templateQuestionCount
                || omrResult?.answers?.length
                || questionCount
            ),
            10
        ) || questionCount;
        const activeQuestionNumbers = buildActiveQuestionNumbers(rawTemplateQuestionCount, questionCount, effectiveSubjects);
        omrResult = applyActiveMaskToOmrResult(omrResult, activeQuestionNumbers, rawTemplateQuestionCount);
        {
            const guard = suppressLikelyFalsePositiveBlank(omrResult);
            omrResult = guard.result;
        }

        if (omrResult.barcodeData && Object.keys(omrResult.barcodeData).length > 0) {
            omrResult.barcodeData = normalizeQrIdentityData(omrResult.barcodeData);
            omrResult.barcodeStatus = omrResult.barcodeStatus || 'qr_success';
        }

        const sheetValidation = validateDetectedSheet(omrResult, questionCount, sheetFormat);
        if (!sheetValidation.valid) {
            console.warn('Rejecting scan:', sheetValidation.details || sheetValidation.error);
            return res.status(422).json({ 
                success: false, 
                error: sheetValidation.error,
                details: sheetValidation.details || null
            });
        }

        // Scanner route is OMR-first: bubble detection + optional manual/queued metadata.
        let text = '';
        let studentName = '';
        let course = '';
        let age = '';
        let roomNo = '';
        const fieldConfidence = {};
        const fieldDebug = null;
        const ocrDebugImagePath = null;
        const extractedDate = '';
        const ocrEngine = 'omr_only';

        if (sourceReceivedPaperId) {
            const papers = await database.query(
                'SELECT student_name, course, age, room_no, entry_type, equity_group, image_path FROM received_papers WHERE id = ?',
                [sourceReceivedPaperId]
            );
            const paper = papers[0];
            if (paper) {
                studentName = cleanExtractedField(paper.student_name || '', 'name') || studentName;
                course = cleanExtractedField(paper.course || '', 'course') || course;
                age = age || (paper.age != null ? String(paper.age) : '');
                roomNo = roomNo || String(paper.room_no || '').trim();
            }
        }

        const barcodeData = omrResult.barcodeData || {};
        const qrStudentMetadata = await resolveStudentMetadataFromQr(barcodeData, quizId);
        const resolvedStudentName = firstNonPlaceholderName(
            manualName,
            studentName,
            qrStudentMetadata.studentName,
            barcodeData.studentName
        );
        const resolvedStudentId = firstNonEmptyText(
            barcodeData.studentId,
            barcodeData.student_id,
            qrStudentMetadata.studentId,
            barcodeData.sheetId,
            barcodeData.sheet_id
        );
        const resolvedCourse = cleanExtractedField(
            manualCourse || course || qrStudentMetadata.course || barcodeData.course || '',
            'course'
        );
        const resolvedAge = firstNonEmptyText(manualAge, age, qrStudentMetadata.age, barcodeData.age);
        const resolvedRoomNo = firstNonEmptyText(manualRoom, roomNo, qrStudentMetadata.roomNo, barcodeData.roomNo, barcodeData.room_no);
        // Entry/Equity must come from OMR bubbles (or explicit manual override), not QR/OCR text.
        const resolvedEntryType = manualEntry || omrResult.entryType || '';
        const resolvedResidencyType = manualResidency || omrResult.residencyType || '';
        const resolvedEquityGroup = manualEquity || omrResult.equityGroup || '';
        const resolvedDateTime = barcodeData.dateTime || barcodeData.date_time || qrStudentMetadata.dateTime || extractedDate || '';

        // Calculate score if quizId provided
        let score = 0;
        let correctAnswers = [];
        let scoringStatus = quizId ? 'complete' : 'not_requested';
        if (quizId) {
            correctAnswers = await getCorrectAnswersForQuiz(quizId);
            if (correctAnswers && correctAnswers.length > 0) {
                for (let i = 0; i < Math.min(omrResult.answers.length, correctAnswers.length); i++) {
                    const studentAns = String(omrResult.answers[i] || '').trim().toUpperCase();
                    const correctAns = String(correctAnswers[i] || '').trim().toUpperCase();
                    if (studentAns && correctAns && studentAns === correctAns) {
                        score++;
                    }
                }
            } else {
                correctAnswers = [];
                scoringStatus = 'incomplete';
                omrResult.scoringStatus = 'incomplete';
                omrResult.warnings = appendUniqueWarning(omrResult, SCORING_INCOMPLETE_WARNING);
            }
        } else {
            // If no quiz selected, just count non-empty answers
            score = omrResult.answers.filter(Boolean).length;
        }
        const responseMetadata = buildScanResponseMetadata(omrResult, scoringStatus);

        res.json({
            success: true,
            requestId,
            imageHash,
            imageSizeBytes: imageBuffer.length,
            workerStartedAt,
            workerFinishedAt,
            source: "new_worker_scan",
            cacheHit: false,
            studentName: resolvedStudentName,
            studentId: resolvedStudentId,
            course: resolvedCourse,
            age: resolvedAge,
            roomNo: resolvedRoomNo,
            dateTime: resolvedDateTime,
            entryType: resolvedEntryType,
            residencyType: resolvedResidencyType,
            equityGroup: resolvedEquityGroup,
            barcodeData,
            barcodeStatus: omrResult.barcodeStatus || 'failed',
            proctorStatus: omrResult.proctorStatus || 'Not Verified',
            answers: omrResult.answers,
            correctAnswers: correctAnswers,
            score: score,
            scoringStatus: responseMetadata.scoringStatus,
            confidence: omrResult.confidence,
            overallConfidence: omrResult.overallConfidence,
            detectionCoverage: omrResult.detectionCoverage,
            scanQualityConfidence: omrResult.scanQualityConfidence,
            alignmentConfidence: omrResult.alignmentConfidence || null,
            templateType: omrResult.templateType || null,
            templateConfidence: omrResult.templateConfidence || null,
            templateMetrics: omrResult.templateMetrics || null,
            questionMetrics: omrResult.questionMetrics || [],
            debugThresholds: omrResult.debugThresholds || null,
            debugSummary: omrResult.debugSummary || null,
            activeQuestionNumbers: omrResult.activeQuestionNumbers || [],
            activeQuestionCount: Number(omrResult.activeQuestionCount || 0),
            totalTemplateQuestions: Number(omrResult.totalTemplateQuestions || (Array.isArray(omrResult.answers) ? omrResult.answers.length : questionCount)),
            omrEngineUsed: omrResult.omrEngineUsed || 'generated-layout',
            scanMode: responseMetadata.scanMode,
            layoutFound: responseMetadata.layoutFound,
            layoutId: responseMetadata.layoutId,
            examId: responseMetadata.examId,
            workerUsed: responseMetadata.workerUsed,
            layoutBubbleCount: responseMetadata.layoutBubbleCount,
            evaluatedBubbleCount: responseMetadata.evaluatedBubbleCount,
            detectedAnswerCount: responseMetadata.detectedAnswerCount,
            detectedBubbleCount: responseMetadata.detectedBubbleCount,
            mappedBubbleCount: responseMetadata.mappedBubbleCount,
            mappingConfidence: responseMetadata.mappingConfidence,
            reviewStatus: responseMetadata.reviewStatus || (sheetValidation.needsReview || (omrResult.overallConfidence || 0) < 0.55 ? 'needs_review' : 'auto_scanned'),
            needsReview: responseMetadata.needsReview || sheetValidation.needsReview || (omrResult.overallConfidence || 0) < 0.55,
            falsePositiveSuppressed: Boolean(omrResult.falsePositiveSuppressed),
            falsePositiveSuppressionReason: omrResult.falsePositiveSuppressionReason || '',
            warnings: responseMetadata.warnings,
            entryGroup: responseMetadata.entryGroup,
            equityGroupResult: omrResult.equityGroupResult || null,
            rawText: text,
            extractedDate: debug ? extractedDate : '',
            fieldConfidence: debug ? fieldConfidence : {},
            fieldDebug: debug ? fieldDebug : null,
            ocrEngine,
            imagePath: typeof photo === 'string' && !photo.startsWith('data:image/') ? photo : null,
            debugImagePath: responseMetadata.debugImagePath || (debug ? ocrDebugImagePath : null),
            sourceReceivedPaperId: sourceReceivedPaperId || null,
            studentLookupSource: qrStudentMetadata.source || null,
            quizId: quizId,
            message: 'Data extracted successfully'
        });

    } catch (error) {
        console.error('AI Vision Processing Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to get subject info
async function getSubjectInfo(subjectCode) {
    const subject = await database.query('SELECT id, code, name FROM subjects WHERE code = ?', [subjectCode]);
    return subject.length > 0 ? subject[0] : { id: 0, code: subjectCode, name: subjectCode };
}

// New endpoint for subject-based reports
router.get('/reports/subjects', authenticateToken, async (req, res) => {
    try {
        const { subjectCode, dateFrom, dateTo, minScore, maxScore, entryType, residencyType, equityGroup } = req.query;
        
        let query = `
            SELECT
                sr.*,
                sub.name as subject_name,
                COALESCE(
                    NULLIF(TRIM(sc.department), ''),
                    NULLIF(TRIM(sc.course), ''),
                    'Unassigned'
                ) as department_label
            FROM subject_records sr
            LEFT JOIN subjects sub ON sr.subject_code = sub.code
            LEFT JOIN scans sc ON sc.id = sr.scan_id
            WHERE 1=1
              AND EXISTS (
                  SELECT 1
                  FROM records r
                  WHERE (
                      sc.image_path IS NOT NULL
                      AND r.image_path = sc.image_path
                  )
                  OR (
                      sc.image_path IS NULL
                      AND r.student_name = sc.student_name
                      AND COALESCE(r.quiz_id, 0) = COALESCE(sc.quiz_id, 0)
                      AND ABS(strftime('%s', r.timestamp) - strftime('%s', sc.timestamp)) <= 5
                  )
              )
        `;
        const params = [];
        
        if (subjectCode) {
            query += ' AND sr.subject_code = ?';
            params.push(subjectCode);
        }
        if (entryType) {
            query += ' AND sr.entry_type = ?';
            params.push(entryType);
        }
        if (residencyType) {
            query += ' AND sr.residency_type = ?';
            params.push(residencyType);
        }
        if (equityGroup) {
            query += ' AND sr.special_equity_group = ?';
            params.push(equityGroup);
        }
        if (dateFrom) {
            query += ' AND sr.timestamp >= ?';
            params.push(dateFrom);
        }
        if (dateTo) {
            // Add time to dateTo to include the entire day
            const endOfDay = dateTo.includes(' ') ? dateTo : `${dateTo} 23:59:59`;
            query += ' AND sr.timestamp <= ?';
            params.push(endOfDay);
        }
        if (minScore) {
            query += ' AND sr.score >= ?';
            params.push(parseInt(minScore));
        }
        if (maxScore) {
            query += ' AND sr.score <= ?';
            params.push(parseInt(maxScore));
        }
        
        query += ' ORDER BY sr.timestamp DESC, sr.student_id, sr.subject_code';
        
        const records = await database.query(query, params);
        
        // Calculate statistics
        const stats = {
            totalRecords: records.length,
            bySubject: {},
            averageScores: {},
            passRates: {},
            entryTypeDistribution: {},
            residencyTypeDistribution: {},
            equityGroupDistribution: {}
        };
        
        records.forEach(record => {
            // By Subject
            if (!stats.bySubject[record.subject_code]) {
                stats.bySubject[record.subject_code] = [];
            }
            stats.bySubject[record.subject_code].push(record);

            // Distribution stats
            const et = record.entry_type || 'N/A';
            stats.entryTypeDistribution[et] = (stats.entryTypeDistribution[et] || 0) + 1;

            const rt = record.residency_type || 'N/A';
            stats.residencyTypeDistribution[rt] = (stats.residencyTypeDistribution[rt] || 0) + 1;

            const eg = record.special_equity_group || 'N/A';
            stats.equityGroupDistribution[eg] = (stats.equityGroupDistribution[eg] || 0) + 1;
        });
        
        for (const [subject, subjectRecords] of Object.entries(stats.bySubject)) {
            const total = subjectRecords.length;
            const totalScore = subjectRecords.reduce((sum, r) => sum + r.score, 0);
            const totalPct = subjectRecords.reduce((sum, r) => sum + parseFloat(r.percentage), 0);
            const passed = subjectRecords.filter(r => isPassingStatus(r.status)).length;
            
            stats.averageScores[subject] = (totalPct / total).toFixed(1);
            stats.passRates[subject] = (passed / total * 100).toFixed(1);
        }
        
        res.json({ records, statistics: stats });
    } catch (error) {
        console.error('Error in subject reports:', error);
        res.status(500).json({ error: error.message });
    }
});

// Bulk delete subject records with filters
// GET /subject-records is handled by /reports/subjects endpoint above
// This redirect handler is for backward compatibility
router.get('/subject-records', authenticateToken, (req, res) => {
    // Forward the query parameters to the reports/subjects handler
    const queryString = Object.entries(req.query)
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
        .join('&');
    res.redirect('/api/reports/subjects' + (queryString ? '?' + queryString : ''));
});

router.delete('/subject-records/bulk-delete', authenticateToken, async (req, res) => {
    try {
        const { subjectCode, dateFrom, dateTo, entryType, equityGroup } = req.query;
        
        let query = 'DELETE FROM subject_records WHERE 1=1';
        const params = [];
        
        if (subjectCode) {
            query += ' AND subject_code = ?';
            params.push(subjectCode);
        }
        if (entryType) {
            query += ' AND entry_type = ?';
            params.push(entryType);
        }
        if (equityGroup) {
            query += ' AND special_equity_group = ?';
            params.push(equityGroup);
        }
        if (dateFrom) {
            query += ' AND timestamp >= ?';
            params.push(dateFrom);
        }
        if (dateTo) {
            const endOfDay = dateTo.includes(' ') ? dateTo : `${dateTo} 23:59:59`;
            query += ' AND timestamp <= ?';
            params.push(endOfDay);
        }
        
        const result = await database.run(query, params);
        res.json({ 
            success: true, 
            message: `${result.changes || 0} record(s) deleted successfully`,
            deletedCount: result.changes || 0
        });
    } catch (error) {
        console.error('Error bulk deleting subject records:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete individual subject record
router.delete('/subject-records/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await database.run('DELETE FROM subject_records WHERE id = ?', [id]);
        res.json({ success: true, message: 'Record deleted successfully' });
    } catch (error) {
        console.error('Error deleting subject record:', error);
        res.status(500).json({ error: error.message });
    }
});

// Received Papers endpoints
router.get('/received-papers', authenticateToken, async (req, res) => {
    try {
        const papers = await database.query('SELECT * FROM received_papers ORDER BY timestamp DESC');
        const papersWithUrls = papers.map(paper => ({
            ...paper,
            image_url: paper.image_path
                ? `${req.protocol}://${req.get('host')}${String(paper.image_path).replace(/^\/uploads\//, '/api/uploads/')}`
                : null
        }));
        res.json(papersWithUrls);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/received-papers', async (req, res) => {
    try {
        const body = req.body || {};
        const sheet_id = body.sheet_id || body.sheetId || body.answer_sheet_id || body.answerSheetId || body.paper_id || body.paperId;
        const student_id = body.student_id || body.studentId;
        const exam_id = body.exam_id || body.examId;
        const requested_file_name = body.image_file_name || body.imageFileName || body.filename || body.fileName;
        const student_name = body.student_name || body.studentName || body.full_name || body.fullName || body.student;
        const course = body.course || body.course_name || body.courseName || body.section || body.program;
        const age = body.age;
        const room_no = body.room_no || body.roomNo || body.room;
        const entry_type = body.entry_type || body.entryType;
        const equity_group = body.equity_group || body.equityGroup;
        const device_id = body.device_id || body.deviceId || body.android_id || body.androidId;
        const image_data = body.image_data || body.imageData || body.image || body.imageBase64 || body.base64 || body.photo;
        const sender_ip = req.ip || req.connection.remoteAddress;
        const safeStudentName = (student_name || '').trim() || 'Unknown Student';
        const safeCourse = (course || '').trim() || 'Unassigned Course';

        if (!image_data) {
            return res.status(400).json({ error: 'Image data is required' });
        }

        const limitField = device_id ? 'device_id' : 'sender_ip';
        const limitValue = device_id || sender_ip;
        const existingPapers = await database.query(`SELECT COUNT(*) as count FROM received_papers WHERE ${limitField} = ?`, [limitValue]);

        if (existingPapers[0].count >= 50) {
            return res.status(429).json({ 
                error: 'Limit reached: 50 papers per phone/device. Please process or delete existing papers first.' 
            });
        }

        // Process image
        const normalizedImageInput = String(image_data || '').trim();
        const matches = normalizedImageInput.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let imageBuffer;
        let mimeType;
        
        if (matches && matches.length === 3) {
            mimeType = matches[1];
            imageBuffer = Buffer.from(matches[2], 'base64');
        } else {
            // Try raw base64 if not in data URI format (including URL-safe base64)
            const base64 = normalizedImageInput
                .replace(/\s+/g, '')
                .replace(/-/g, '+')
                .replace(/_/g, '/');
            const paddedBase64 = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
            imageBuffer = Buffer.from(paddedBase64, 'base64');
            mimeType = 'image/jpeg'; // Default
        }

        if (!imageBuffer || imageBuffer.length < 100) {
            return res.status(400).json({ error: 'Invalid image payload (too small or malformed)' });
        }

        // Calculate image hash for duplicate detection
        const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

        // Check for duplicate by hash
        const hashDuplicates = await database.query(
            'SELECT id, student_name, timestamp FROM received_papers WHERE image_hash = ? LIMIT 1',
            [imageHash]
        );

        if (hashDuplicates.length > 0) {
            const dup = hashDuplicates[0];
            return res.status(409).json({
                success: false,
                duplicate: true,
                error: `This image has already been uploaded by ${dup.student_name} on ${new Date(dup.timestamp).toLocaleString()}.`,
                existingId: dup.id
            });
        }

        const fileExtension = mimeType.split('/')[1] || 'jpg';

        const label = requested_file_name || sheet_id || student_id || student_name || course || 'paper';
        const filename = sanitizeReceivedPaperFileName(label, fileExtension);
        const relativePath = `/uploads/received/${filename}`;
        const fullPath = resolveStoredImageAbsolutePath(relativePath);

        // Ensure directory exists
        const receivedDir = runtimePaths.uploadsReceivedDir;
        if (!fs.existsSync(receivedDir)) {
            fs.mkdirSync(receivedDir, { recursive: true });
        }

        const duplicateRows = await database.query(
            'SELECT id FROM received_papers WHERE image_file_name = ? OR image_path = ? LIMIT 1',
            [filename, relativePath]
        );
        if (duplicateRows.length > 0 || fs.existsSync(fullPath)) {
            return res.status(409).json({
                success: false,
                duplicate: true,
                filename,
                error: 'Duplicate image filename'
            });
        }

        fs.writeFileSync(fullPath, imageBuffer);

        const result = await database.run(
            'INSERT INTO received_papers (sheet_id, student_id, exam_id, student_name, course, age, room_no, seat_no, entry_type, equity_group, image_file_name, image_path, sender_ip, device_id, image_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [sheet_id || null, student_id || null, exam_id || null, safeStudentName, safeCourse, age || null, room_no || null, null, entry_type || null, equity_group || null, filename, relativePath, sender_ip, device_id || null, imageHash]
        );

        res.json({ 
            success: true, 
            id: result.id, 
            sheet_id: sheet_id || null,
            student_id: student_id || null,
            exam_id: exam_id || null,
            image_file_name: filename,
            image_path: relativePath,
            student_name: safeStudentName,
            course: safeCourse,
            room_no: room_no
        });
    } catch (error) {
        console.error('Error processing received paper:', error);
        res.status(500).json({ error: error.message });
    }
});

router.delete('/received-papers/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const paper = await database.query('SELECT image_path FROM received_papers WHERE id = ?', [id]);
        
        if (paper.length > 0 && paper[0].image_path) {
            const fullPath = resolveStoredImageAbsolutePath(paper[0].image_path);
            if (fullPath && fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }

        await database.run('DELETE FROM received_papers WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- MASSIVE BACKUP & RESTORE SYSTEM ---

router.post('/system/backup/restore-uploaded', authenticateToken, async (req, res) => {
    try {
        const { uploadId } = req.body;
        const sessionDir = path.join(UPLOAD_SESSIONS_ROOT, uploadId);
        
        if (!fs.existsSync(sessionDir)) {
            return res.status(404).json({ success: false, error: 'Upload session not found' });
        }

        const metadata = JSON.parse(fs.readFileSync(path.join(sessionDir, 'metadata.json'), 'utf8'));
        const finalZipPath = path.join(sessionDir, metadata.fileName);

        if (!fs.existsSync(finalZipPath)) {
            return res.status(404).json({ success: false, error: 'Merged backup file not found.' });
        }

        console.log(`[Restore] Restoring from uploaded backup: ${metadata.fileName} (${uploadId})`);
        await performAtomicRestore(finalZipPath, res);
        safeRm(sessionDir);
    } catch (error) {
        console.error('[Restore] Uploaded Restore Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/system/backup/restore-path', authenticateToken, async (req, res) => {
    try {
        const { backupPath } = req.body;
        const absolutePath = resolveCalibrationSourcePath(backupPath);
        if (!absolutePath || !fs.existsSync(absolutePath)) {
            return res.status(404).json({ success: false, error: `Backup file not found at: ${backupPath}` });
        }
        await performAtomicRestore(absolutePath, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/system/backup/restore-history', authenticateToken, async (req, res) => {
    try {
        const { fileName } = req.body;
        if (!fileName) return res.status(400).json({ success: false, error: 'FileName is required' });
        const archivePath = path.join(BACKUP_ARCHIVE_DIR, path.basename(fileName));
        if (!fs.existsSync(archivePath)) {
            return res.status(404).json({ success: false, error: `History backup not found: ${fileName}` });
        }
        await performAtomicRestore(archivePath, res);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

 // Admin endpoint: backfill subject scores for scans with missing data
router.post('/admin/backfill-subject-scores', authenticateToken, async (req, res) => {
    try {
        const scans = await database.query(`
            SELECT id, student_id, student_name, quiz_id, answers, entry_type, residency_type,
                   special_equity_group, room_no, exam_date_time, subject_scores,
                   score, total_questions, percentage, status, overall_status
            FROM scans
            WHERE answers IS NOT NULL
              AND (subject_scores IS NULL OR TRIM(subject_scores) = '')
        `);
        let updated = 0;
        for (const scan of scans) {
            let answers = [];
            try {
                const parsed = JSON.parse(scan.answers || '[]');
                answers = Array.isArray(parsed) ? parsed : [];
            } catch (_error) {
                answers = [];
            }
            if (!answers.length) continue;
            const quizSummary = await getQuizSummary(scan.quiz_id);
            const subjectResults = quizSummary.format === 'normal'
                ? buildSingleSubjectResultsFromOverall({
                    quizSummary,
                    score: scan.score,
                    totalQuestions: scan.total_questions || answers.length || 100,
                    percentage: scan.percentage,
                    status: scan.overall_status || scan.status
                })
                : await calculateSubjectScores(answers, scan.quiz_id);
            const legacyEng = getSubjectScoreEntry(subjectResults, 'ENG');
            const legacySci = getSubjectScoreEntry(subjectResults, 'SCI');
            const legacyMath = getSubjectScoreEntry(subjectResults, 'MATH');
            const legacyGen = getSubjectScoreEntry(subjectResults, 'GEN');
            const legacyAbs = getSubjectScoreEntry(subjectResults, 'ABS');
            await database.run(`
                UPDATE scans
                SET english_score = ?, english_percentage = ?, english_status = ?,
                    science_score = ?, science_percentage = ?, science_status = ?,
                    math_score = ?, math_percentage = ?, math_status = ?,
                    general_score = ?, general_percentage = ?, general_status = ?,
                    abstract_score = ?, abstract_percentage = ?, abstract_status = ?,
                    score_breakdown = ?, subject_scores = ?
                WHERE id = ?
            `, [
                legacyEng.score, legacyEng.percentage, legacyEng.status,
                legacySci.score, legacySci.percentage, legacySci.status,
                legacyMath.score, legacyMath.percentage, legacyMath.status,
                legacyGen.score, legacyGen.percentage, legacyGen.status,
                legacyAbs.score, legacyAbs.percentage, legacyAbs.status,
                JSON.stringify(Object.fromEntries(Object.entries(subjectResults).filter(([key]) => !['totalScore', 'totalQuestions', 'overallPercentage', 'overallStatus', 'scoringStatus'].includes(key)).map(([key, value]) => [key, value?.score || 0]))),
                JSON.stringify(subjectResults),
                scan.id
            ]);
            await database.run('DELETE FROM subject_records WHERE scan_id = ?', [scan.id]);
            await saveSubjectRecordsForScan({
                scanId: scan.id,
                studentId: scan.student_id || 'N/A',
                studentName: scan.student_name || 'Anonymous',
                subjectResults,
                entryType: scan.entry_type || null,
                residencyType: scan.residency_type || null,
                equityGroup: scan.special_equity_group || null,
                roomNo: scan.room_no || null,
                examDateTime: scan.exam_date_time || null
            });
            updated++;
        }
        res.json({ success: true, updated, message: `${updated} scans updated with subject scores` });
    } catch (error) {
        console.error('Backfill subject scores error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
module.exports = router;
