// Configuration for ScanCheck System
class ScanCheckConfig {
    constructor() {
        this.currentOrigin = this.getCurrentOrigin();

        const raw = localStorage.getItem('scancheck_server_url') || this.currentOrigin;
        this.serverUrl = this.normalizeBaseUrl(raw) || this.currentOrigin;

        if (!this.serverUrl || this.serverUrl === 'null' || this.serverUrl === 'undefined' || this.serverUrl.startsWith('file:')) {
            this.serverUrl = this.currentOrigin;
        }

        if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
            try {
                const configUrl = new URL(this.serverUrl, this.currentOrigin);
                if (configUrl.hostname === 'localhost' && configUrl.port !== window.location.port) {
                    console.log(`[ScanCheck] Updating localhost port from ${configUrl.port} to ${window.location.port}`);
                    this.serverUrl = this.currentOrigin;
                    localStorage.setItem('scancheck_server_url', this.serverUrl);
                }
            } catch (e) {
                this.serverUrl = this.currentOrigin;
            }
        }

        this.currentQuiz = null;
    }

    getCurrentOrigin() {
        if (typeof window === 'undefined') {
            return 'http://localhost:3000';
        }

        const origin = window.location.origin;
        if (origin && origin !== 'null' && !origin.startsWith('file:')) {
            return origin;
        }

        return 'http://localhost:3000';
    }

    normalizeBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    resolveUrl(endpoint) {
        if (endpoint.startsWith('http')) {
            return endpoint;
        }

        const currentOrigin = this.getCurrentOrigin();
        let configUrl = null;
        try {
            configUrl = this.serverUrl ? new URL(this.serverUrl, currentOrigin) : null;
        } catch (e) {
            configUrl = null;
        }

        const configHost = configUrl ? configUrl.host : '';
        const currentHost = typeof window !== 'undefined' ? window.location.host : '';
        const isFile = typeof window !== 'undefined' && window.location.protocol === 'file:';

        if (!this.serverUrl || (configHost && configHost === currentHost && !isFile)) {
            return endpoint;
        }

        if (configUrl) {
            return new URL(endpoint.replace(/^\/+/, ''), `${configUrl.origin}/`).toString();
        }

        return endpoint;
    }

    resolveAssetUrl(assetPath) {
        const rawPath = String(assetPath || '').trim();
        if (!rawPath) return null;
        if (/^(https?:|data:)/i.test(rawPath)) return rawPath;

        const cleanedPath = rawPath
            .replace(/^https?:\/\/[^/]+/i, '')
            .replace(/^\/+/, '');

        if (!cleanedPath) return null;

        const base = this.normalizeBaseUrl(this.serverUrl) || this.currentOrigin;
        try {
            const url = new URL(base, this.currentOrigin);
            return new URL(cleanedPath, `${url.origin}/`).toString();
        } catch (e) {
            return `/${cleanedPath}`;
        }
    }

    updateServerUrl(url) {
        const trimmed = this.normalizeBaseUrl(url) || (window.location.origin || 'http://localhost:3000');
        this.serverUrl = trimmed;
        localStorage.setItem('scancheck_server_url', this.serverUrl);

        return this.testConnection();
    }

    async testConnection() {
        const url = this.resolveUrl('/api/health');

        try {
            const response = await fetch(url);
            const bodyText = await response.text();
            let payload = null;

            try {
                payload = bodyText ? JSON.parse(bodyText) : null;
            } catch (e) {
                payload = null;
            }

            if (!response.ok) {
                const detail = payload?.error || bodyText || `HTTP ${response.status}`;
                throw new Error(detail);
            }

            return {
                success: true,
                message: 'Connected to server'
            };
        } catch (error) {
            return {
                success: false,
                message: `Cannot reach server at ${url}: ${error.message}`
            };
        }
    }

    async apiCall(endpoint, options = {}) {
        const url = this.resolveUrl(endpoint);

        console.log(`[ScanCheck] API Call: ${options.method || 'GET'} ${url}`);

        try {
            const token = localStorage.getItem('scancheck_token');
            const headers = {
                'Content-Type': 'application/json',
                ...options.headers
            };

            if (token && token !== 'undefined' && token !== 'null') {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const response = await fetch(url, {
                ...options,
                headers
            });

            if (!response.ok) {
                let bodyText = '';
                try {
                    bodyText = await response.text();
                } catch (e) {}

                if (response.status === 401 || response.status === 403) {
                    localStorage.removeItem('scancheck_token');
                    window.dispatchEvent(new Event('scancheck:unauthorized'));
                }

                let detail = bodyText;
                let parsedPayload = null;
                try {
                    parsedPayload = JSON.parse(bodyText);
                    if (parsedPayload && parsedPayload.error) detail = parsedPayload.error;
                } catch (e) {}

                const apiError = new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
                apiError.status = response.status;
                apiError.statusCode = response.status;
                if (parsedPayload?.code) apiError.code = parsedPayload.code;
                if (parsedPayload) apiError.payload = parsedPayload;
                if (parsedPayload?.details) apiError.details = parsedPayload.details;
                throw apiError;
            }

            if (response.status === 204 || response.headers.get('content-length') === '0') {
                return null;
            }

            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } catch (error) {
            console.error(`[ScanCheck] API Error for ${url}:`, error);

            if (error.name === 'TypeError' || error.message.includes('fetch')) {
                const helpMsg = `Cannot connect to server at ${url}. 
                    1. Check if the server is running.
                    2. Ensure Server URL in settings is correct.
                    3. If using a phone, use your PC's local IP address such as http://192.168.x.x:3000.`;
                throw new Error(helpMsg);
            }

            throw error;
        }
    }
}

// Global configuration instance
window.scanCheckConfig = new ScanCheckConfig();
