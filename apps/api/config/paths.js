const fs = require('fs');
const path = require('path');

const API_ROOT = path.resolve(__dirname, '..');
const APPS_ROOT = path.resolve(API_ROOT, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

function resolvePath(value, fallback) {
    const input = String(value || '').trim();
    if (!input) return fallback;
    return path.isAbsolute(input) ? input : path.resolve(REPO_ROOT, input);
}

const runtimeRoot = resolvePath(process.env.SCANCHECK_RUNTIME_ROOT, path.join(REPO_ROOT, '.runtime'));
const dataDir = resolvePath(process.env.SCANCHECK_DATA_DIR, path.join(runtimeRoot, 'data'));
const logDir = resolvePath(process.env.SCANCHECK_LOG_DIR, path.join(runtimeRoot, 'logs'));
const tmpDir = resolvePath(process.env.SCANCHECK_TMP_DIR, path.join(runtimeRoot, 'tmp'));

const uploadsDir = path.join(dataDir, 'uploads');
const uploadsImagesDir = path.join(uploadsDir, 'images');
const uploadsThumbnailsDir = path.join(uploadsDir, 'thumbnails');
const uploadsReceivedDir = path.join(uploadsDir, 'received');
const uploadsDebugDir = path.join(uploadsDir, 'debug');
const omrLayoutsDir = path.join(dataDir, 'omr-layouts');
const generatedSheetsDir = path.join(dataDir, 'generated-sheets');

// Course logo overrides. The shipped defaults live in apps/web/images and are
// tracked by git; anything a user uploads lands here so replacing a logo never
// dirties the repository with a multi-megabyte binary.
const courseLogosDir = resolvePath(process.env.SCANCHECK_COURSE_LOGOS_DIR, path.join(runtimeRoot, 'courselogos'));

const omrServiceRoot = resolvePath(process.env.SCANCHECK_OMR_SERVICE_DIR, path.join(REPO_ROOT, 'services', 'omr-python'));
const omrCalibrationInputDir = resolvePath(
    process.env.SCANCHECK_OMR_CALIBRATION_DIR,
    path.join(runtimeRoot, 'omr-calib', 'input')
);

const paths = {
    repoRoot: REPO_ROOT,
    appsRoot: APPS_ROOT,
    apiRoot: API_ROOT,
    webRoot: path.join(APPS_ROOT, 'web'),
    runtimeRoot,
    dataDir,
    logDir,
    tmpDir,
    dbPath: resolvePath(process.env.SCANCHECK_DB_PATH, path.join(dataDir, 'scancheck.db')),
    jwtSecretFile: resolvePath(process.env.SCANCHECK_JWT_SECRET_FILE, path.join(dataDir, '.jwt_secret')),
    currentPortFile: resolvePath(process.env.SCANCHECK_PORT_FILE, path.join(runtimeRoot, 'current_port.txt')),
    uploadsDir,
    uploadsImagesDir,
    uploadsThumbnailsDir,
    uploadsReceivedDir,
    uploadsDebugDir,
    omrLayoutsDir,
    generatedSheetsDir,
    courseLogosDir,
    omrServiceRoot,
    omrCalibrationInputDir,
    omrTemplateDir: path.join(omrServiceRoot, 'omrchecker-template'),
    pythonOmrDir: path.join(omrServiceRoot, 'python_omr')
};

function ensureRuntimeDirs() {
    [
        paths.runtimeRoot,
        paths.dataDir,
        paths.logDir,
        paths.tmpDir,
        paths.uploadsDir,
        paths.uploadsImagesDir,
        paths.uploadsThumbnailsDir,
        paths.uploadsReceivedDir,
        paths.uploadsDebugDir,
        paths.omrLayoutsDir,
        paths.generatedSheetsDir,
        paths.courseLogosDir
    ].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

module.exports = {
    ...paths,
    ensureRuntimeDirs
};
