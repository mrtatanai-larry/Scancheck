const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const os = require('os');
const database = require('./database');
const api = require('./api');
const paths = require('./config/paths');

const app = express();
const SERVER_HOST = '0.0.0.0'; // Listen on all interfaces for LAN access
const SERVER_PORT = process.env.SCANCHECK_PORT || 3000;

paths.ensureRuntimeDirs();

function isAllowedHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    if (host === '::1' || host.startsWith('192.168.') || host.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
        return true;
    }
    return false;
}

function getLocalIpAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    const hotspotPattern = /^192\.168\.137\./;

    for (const values of Object.values(interfaces)) {
        for (const info of values || []) {
            if (info.family === 'IPv4' && !info.internal) {
                addresses.push(info.address);
            }
        }
    }

    // Sort addresses so non-hotspot addresses come first
    addresses.sort((a, b) => {
        const aIsHotspot = hotspotPattern.test(a);
        const bIsHotspot = hotspotPattern.test(b);
        if (aIsHotspot && !bIsHotspot) return 1;
        if (!aIsHotspot && bIsHotspot) return -1;
        return 0;
    });

    return [...new Set(addresses)];
}

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);

        try {
            const parsed = new URL(origin);
            if (isAllowedHost(parsed.hostname)) {
                return callback(null, true);
            }
        } catch (error) {
            // fall through
        }

        return callback(new Error('ScanCheck only allows localhost and local-network origins.'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Backup-Filename', 'X-Upload-Id', 'X-Chunk-Index', 'X-Total-Chunks']
}));

// --- Middleware Configuration ---
// Note: Body parsers are skipped for binary upload routes to allow raw streaming of massive files
app.use((req, res, next) => {
    // Skip body parser for binary chunks
    const isChunkUpload = req.method === 'POST' && req.path === '/api/system/backup/upload/chunk';
    const isDirectRestore = req.method === 'POST' && req.path === '/api/system/backup/restore';

    if (isChunkUpload || isDirectRestore) {
        return next();
    }

    bodyParser.json({ limit: '100mb' })(req, res, (err) => {
        if (err) {
            console.error('[Middleware] JSON Body Parser Error:', err.message);
            return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
        }
        bodyParser.urlencoded({ limit: '100mb', extended: true })(req, res, (err2) => {
            if (err2) {
                console.error('[Middleware] URL-Encoded Body Parser Error:', err2.message);
                return res.status(400).json({ success: false, error: 'Invalid form data' });
            }
            next();
        });
    });
});

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

app.use('/vendor/bootstrap', express.static(path.join(paths.apiRoot, 'node_modules', 'bootstrap', 'dist')));
app.use('/vendor/fontawesome', express.static(path.join(paths.apiRoot, 'node_modules', '@fortawesome', 'fontawesome-free')));
app.use('/vendor/jsbarcode', express.static(path.join(paths.apiRoot, 'node_modules', 'jsbarcode', 'dist')));
app.use('/vendor/exceljs', express.static(path.join(paths.apiRoot, 'node_modules', 'exceljs', 'dist')));
app.use('/vendor/chart.js', express.static(path.join(paths.apiRoot, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/html2canvas', express.static(path.join(paths.apiRoot, 'node_modules', 'html2canvas', 'dist')));
app.use(express.static(paths.webRoot, { index: false }));
app.use('/uploads', express.static(paths.uploadsDir));

app.use('/api', api);

app.get('/', (req, res) => {
    res.sendFile(path.join(paths.webRoot, 'index4.html'));
});

console.log('Starting database initialization...');
console.log('AI Vision Scanner Mode Enabled');
console.log('Legacy deterministic OMR product path disabled');

let server; // Keep reference for graceful shutdown

database.init().then(async () => {
    console.log('Database initialized successfully.');
    try {
        server = app.listen(SERVER_PORT, SERVER_HOST, () => {
            const addr = server.address();
            const port = addr.port;
            console.log(`🚀 ScanCheck Server running at http://0.0.0.0:${port}`);
            console.log(`📂 Web root: ${paths.webRoot}`);

            // Show LAN-accessible addresses
            const localIps = getLocalIpAddresses();
            if (localIps.length > 0) {
                console.log('');
                console.log('📱 Access from other devices on your network:');
                localIps.forEach((ip) => {
                    console.log(`   http://${ip}:${port}`);
                });
            }

            const fs = require('fs');
            fs.writeFileSync(paths.currentPortFile, port.toString());
        });

        // Disable timeouts for massive file uploads (150GB+)
        server.timeout = 0;
        server.keepAliveTimeout = 0;
        server.headersTimeout = 0;
        if (server.requestTimeout !== undefined) {
            server.requestTimeout = 0;
        }
        
        console.log('⚡ Server timeouts disabled for large data transfers.');

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}).catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
});

// ==============================================================================
// Graceful Shutdown — close DB connection on SIGTERM/SIGINT
// ==============================================================================
function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] Received ${signal}. Shutting down gracefully...`);
    if (server) {
        server.close(() => {
            console.log('[Shutdown] HTTP server closed.');
            database.close()
                .then(() => {
                    console.log('[Shutdown] Database connection closed.');
                    process.exit(0);
                })
                .catch((err) => {
                    console.error('[Shutdown] Error closing database:', err);
                    process.exit(1);
                });
        });

        // Force exit if graceful shutdown takes too long
        setTimeout(() => {
            console.error('[Shutdown] Forced exit after timeout.');
            process.exit(1);
        }, 10000);
    } else {
        database.close().finally(() => process.exit(0));
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Global error handling to prevent silent crashes during large transfers
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
