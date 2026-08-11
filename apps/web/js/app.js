const PASSING_SCORE = 75;

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function normalizeAnswerOptions(values) {
    if (!Array.isArray(values)) return [];
    const allowed = new Set(['A', 'B', 'C', 'D']);
    const seen = new Set();
    const output = [];
    values.forEach((value) => {
        const option = String(value || '').trim().toUpperCase();
        if (allowed.has(option) && !seen.has(option)) {
            seen.add(option);
            output.push(option);
        }
    });
    return output;
}

function formatOcrAnswerDisplay(answer, metric = {}) {
    const state = String(metric?.state || '').trim().toLowerCase();
    const markedOptions = normalizeAnswerOptions(metric?.markedOptions);
    const normalizedAnswer = String(answer || metric?.answer || '').trim().toUpperCase();

    if (state === 'multiple') {
        return {
            value: markedOptions.length ? `MULT ${markedOptions.join('+')}` : 'MULT',
            className: 'text-danger',
            title: markedOptions.length ? `Multiple marks: ${markedOptions.join(', ')}` : 'Multiple marks'
        };
    }
    if (normalizedAnswer === 'MULTIPLE') {
        return {
            value: 'MULT',
            className: 'text-danger',
            title: 'Multiple marks'
        };
    }
    if (state === 'blank') {
        return {
            value: 'Blank',
            className: 'text-muted',
            title: 'No marked bubble detected'
        };
    }
    if (state === 'uncertain') {
        return {
            value: 'Review',
            className: 'text-warning',
            title: 'AI could not confidently read this question'
        };
    }
    if (normalizedAnswer) {
        return {
            value: normalizedAnswer,
            className: 'text-primary',
            title: `Selected answer: ${normalizedAnswer}`
        };
    }
    return {
        value: '—',
        className: 'text-muted',
        title: 'No answer'
    };
}

function normalizeScanStatus(status, percentage = 0, passingScore = PASSING_SCORE) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'pass' || normalized === 'passinhon') return 'PASS';
    if (normalized === 'fail' || normalized === 'non-passinhon' || normalized === 'non passinhon') return 'FAIL';
    return Number(percentage) >= passingScore ? 'PASS' : 'FAIL';
}

// Main Application Logic
class ScanCheckApp {
    constructor() {
        this.quizzes = [];
        this.scanResults = [];
        this.records = [];
        this.receivedPapers = [];
        this.systems = [];
        this.pendingDeletions = new Map();
        this.selectedScanImage = null;
        this.bubbleDebugImageData = null;
        this.bubbleDebugImageName = '';
        this.bubbleDebugResult = null;
        this.isBubbleDebugScanning = false;
        this.selectedScanImages = [];
        this.bulkScanResults = [];
        this.isBulkScanning = false;
        this.selectedReceivedPaperId = null;
        this.currentOcrResult = null;
        this.detectedScannerLayout = null;
        this.scannerPreviewMode = 'original';
        this.scannerOriginalPreviewImage = null;
        this.scannerAiInputPreviewImage = null;
        this.pendingAction = null; // Store intended action for post-login redirect
        this.answerKeyDirty = false;
        this.answerKeyPlan = null;
        this.answerKeyFocusQuestion = null;
        this.answerKeyLastSavedAt = '';
        this.imageRotation = 0;
        this.imageZoom = 1;
        this.imagePanX = 0;
        this.imagePanY = 0;
        this.scannerImageDragging = false;
        this.scannerImageDragStartX = 0;
        this.scannerImageDragStartY = 0;

        // Image preview zoom/pan state
        this.imagePreviewScale = 1;
        this.imagePreviewTranslateX = 0;
        this.imagePreviewTranslateY = 0;
        this.imagePreviewDragging = false;
        this.imagePreviewDragStartX = 0;
        this.imagePreviewDragStartY = 0;
        
        // Answer sheet preview zoom state
        this.answerSheetPreviewZoom = 1;
        this.answerSheetPreviewMode = 'fit';

        this.answerKeyQuizId = null;
        this.answerKeyOptionSet = ['A', 'B', 'C', 'D'];
        this.answerKeyHashGuardBypass = false;
        this.answerKeyCatalog = [];
        this.answerKeyListFilter = '';
        this.selectedAnswerKeyQuizId = null;
        this.currentRouteHash = '';
        this.omrRecalibrationImageData = '';
        this.omrRecalibrationImageName = '';
        this.selectedSystemBackupFile = null;
        this.importedStudents = [];
        this.filteredImportedStudents = [];
        this.activeImportedStudentIndex = -1;
        this.studentImportBatchToken = '';
        this.selectedInboxPaperIds = new Set();
        this.editingQuizId = null; // Track which quiz we're editing when opening subjects modal
        this.currentQuizType = 'multi'; // Default to multi-subject
        this.init();
    }

    /**
     * Toggle the Edit Subjects button based on exam type
     */
    toggleSubjectsButton(format = null) {
        let quizType = format;
        if (!quizType) {
            const quizTypeEl = document.getElementById('quizType');
            if (quizTypeEl) {
                quizType = quizTypeEl.value;
            } else {
                quizType = 'multi-subject';
            }
        }

        // Hide/show in create exam modal
        const subjectsSection = document.querySelector('#createExamModal .mb-4');
        if (subjectsSection) {
            subjectsSection.style.display = (quizType === 'normal') ? 'none' : 'block';
        }

        const editSubjectsModalBtn = document.getElementById('editSubjectsModalBtn');
        if (editSubjectsModalBtn) {
            editSubjectsModalBtn.style.display = (quizType === 'normal') ? 'none' : 'block';
        }

        // Hide/show main UI edit button
        const editSubjectsBtn = document.getElementById('editSubjectsBtn');
        if (editSubjectsBtn) {
            editSubjectsBtn.style.display = (quizType === 'normal') ? 'none' : 'block';
        }
    }

    /**
     * Wrapper for API calls with authentication error handling
     * @param {string} endpoint - API endpoint
     * @param {Object} options - Fetch options
     * @param {string} context - Context for error messages
     * @returns {Promise} API response
     */
    async apiCallWithAuth(endpoint, options = {}, context = 'operation') {
        try {
            return await scanCheckConfig.apiCall(endpoint, options);
        } catch (error) {
            // Use ErrorHandler to process the error
            const formattedError = errorHandler.handleError(error, context);

            // Handle authentication errors
            if (errorHandler.isAuthError(error)) {
                // Remove invalid token
                localStorage.removeItem('scancheck_token');
                
                // Store the intended action for post-login redirect
                this.pendingAction = { endpoint, options, context };
                
                // Show appropriate auth error message
                let authMessage = 'Your session has expired. Please sign in again.';
                if (error.message && error.message.toLowerCase().includes('invalid')) {
                    authMessage = 'Invalid username or password. Please try again.';
                } else if (error.message && error.message.toLowerCase().includes('permission')) {
                    authMessage = 'You don\'t have permission to perform this action.';
                }
                
                toastManager.showError(authMessage);
                
                // Display login modal
                this.showGuestUI();
                
                // Clear application state
                this.quizzes = [];
                this.scanResults = [];
                this.records = [];
                this.systems = [];
                this.renderQuizList();
                this.renderScanResults();
                this.renderRecords();
                this.renderSystems();
            } else {
                // Show error message for other error types
                toastManager.showError(formattedError.message);
            }

            // Re-throw the error for caller to handle if needed
            throw error;
        }
    }

    /**
     * Retry pending action after successful login
     */
    async retryPendingAction() {
        if (!this.pendingAction) {
            return;
        }

        const { endpoint, options, context } = this.pendingAction;
        this.pendingAction = null;

        try {
            const result = await this.apiCallWithAuth(endpoint, options, context);
            toastManager.showSuccess('Action completed successfully');
            return result;
        } catch (error) {
            // Error already handled by apiCallWithAuth
            console.error('Failed to retry pending action:', error);
        }
    }

    async init() {
        this.setupAuthEventListeners();
        window.addEventListener('scancheck:unauthorized', () => {
            this.handleUnauthorized();
        });
        this.initSettingsUI();
        await this.checkServerConnection();
        
        if (this.isAuthenticated()) {
            this.showAuthenticatedUI();
            await this.loadAllData();
        } else {
            this.showGuestUI();
        }
        
        this.setupEventListeners();
        this.setupWebSocket();
        if (window.bootstrap && document.querySelectorAll('[data-bs-toggle="tooltip"]').length) {
            document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => new bootstrap.Tooltip(el));
        }
    }

    initSettingsUI() {
        const urlInput = document.getElementById('serverUrl');
        const developerPanelsToggle = document.getElementById('settingShowDeveloperTestingPanels');
        const rawDataToggle = document.getElementById('settingShowRawScanData');
        const debugViewToggle = document.getElementById('settingShowOmrDebugView');
        const recalibrationPathInput = document.getElementById('omrRecalibrationImagePath');
        const editorCommandInput = document.getElementById('omrEditorCommand');

        if (urlInput) urlInput.value = scanCheckConfig.serverUrl;
        if (developerPanelsToggle) {
            developerPanelsToggle.checked = localStorage.getItem('scancheck_show_developer_testing_panels') !== '0';
        }
        if (rawDataToggle) {
            rawDataToggle.checked = localStorage.getItem('scancheck_show_raw_scan_data') !== '0';
        }
        if (debugViewToggle) {
            debugViewToggle.checked = localStorage.getItem('scancheck_show_omr_debug_view') !== '0';
        }
        if (recalibrationPathInput) {
            recalibrationPathInput.value = localStorage.getItem('scancheck_omr_recalibration_image_path') || '';
        }
        if (editorCommandInput) {
            editorCommandInput.value = localStorage.getItem('scancheck_omr_editor_command') || 'code';
        }
        const backupLabel = document.getElementById('systemBackupSelectedFile');
        if (backupLabel) backupLabel.textContent = 'No backup file selected.';
        this.setSystemBackupLog('Ready.');
        this.refreshSystemBackupHistory();
        this.loadAiOmrSettings();
        this.applyScannerViewSettings();
    }

    renderAiOmrSettings(settings = {}) {
        const enabled = document.getElementById('aiOmrEnabled');
        const provider = document.getElementById('aiOmrProvider');
        const strategy = document.getElementById('aiOmrStrategy');
        const imageDetail = document.getElementById('aiOmrImageDetail');
        const verificationMode = document.getElementById('aiOmrVerificationMode');
        const model = document.getElementById('aiOmrModel');
        const baseUrl = document.getElementById('aiOmrBaseUrl');
        const sectionSize = document.getElementById('aiOmrSectionSize');
        const timeoutMs = document.getElementById('aiOmrTimeoutMs');
        const maxRetries = document.getElementById('aiOmrMaxRetries');
        const confidenceThreshold = document.getElementById('aiOmrConfidenceThreshold');
        const instructionPrompt = document.getElementById('aiOmrInstructionPrompt');
        const promptVersion = document.getElementById('aiOmrPromptVersion');
        const keyInput = document.getElementById('aiOmrApiKey');
        const keyStatus = document.getElementById('aiOmrKeyStatus');
        const keyPreview = document.getElementById('aiOmrKeyPreview');
        const statusBadge = document.getElementById('aiOmrConnectionBadge');
        const statusText = document.getElementById('aiOmrStatusText');
        const providerText = document.getElementById('aiOmrProviderText');
        const scannerText = document.getElementById('aiOmrProductionScannerText');

        if (enabled) enabled.checked = true;
        if (provider) provider.value = 'gemini';
        if (providerText) providerText.textContent = 'Gemini';
        if (scannerText) scannerText.textContent = 'AI Vision';
        if (strategy) strategy.value = settings.strategy || 'auto';
        if (imageDetail) imageDetail.value = settings.imageDetail || 'medium';
        if (verificationMode) verificationMode.value = settings.verificationMode || 'uncertain';
        if (model) {
            const selectedModel = String(settings.model || 'gemini-3.6-flash').trim();
            const supportedModels = Array.from(model.options || []).map((option) => option.value);
            model.value = supportedModels.includes(selectedModel) ? selectedModel : 'gemini-3.6-flash';
        }
        if (baseUrl) baseUrl.value = settings.baseUrl || 'http://localhost:11434';
        if (sectionSize) sectionSize.value = String(settings.sectionSize || 20);
        if (timeoutMs) timeoutMs.value = String(settings.timeoutMs || 30000);
        if (maxRetries) maxRetries.value = String(settings.maxRetries ?? 2);
        if (confidenceThreshold) confidenceThreshold.value = String(settings.confidenceThreshold ?? 0.75);
        if (instructionPrompt) instructionPrompt.value = settings.instructionPrompt || '';
        if (promptVersion) promptVersion.value = settings.promptVersion || 'omr-prompt-v1';
        if (keyInput) keyInput.value = '';
        if (keyPreview) {
            keyPreview.textContent = settings.hasApiKey ? (settings.apiKeyPreview || 'Configured') : 'Not configured';
        }
        if (keyStatus) {
            keyStatus.textContent = settings.hasApiKey
                ? `Saved backend key: ${settings.apiKeyPreview || 'configured'}`
                : 'No backend Gemini API key saved.';
            keyStatus.classList.toggle('text-success', Boolean(settings.hasApiKey));
            keyStatus.classList.toggle('text-muted', !settings.hasApiKey);
        }
        if (statusText) statusText.textContent = settings.hasApiKey ? 'Configured' : 'Missing API key';
        if (statusBadge) {
            statusBadge.textContent = settings.hasApiKey ? 'Gemini Connected' : 'Setup Required';
            statusBadge.className = `badge ${settings.hasApiKey ? 'bg-success' : 'bg-warning text-dark'} ms-auto`;
        }
        this.aiOmrDefaultPrompt = settings.defaultPrompt || this.aiOmrDefaultPrompt || '';
        this.updateAiOmrProviderFields();
    }

    updateAiOmrProviderFields() {
        const model = document.getElementById('aiOmrModel');
        const apiKey = document.getElementById('aiOmrApiKey');
        const baseUrlGroup = document.getElementById('aiOmrBaseUrlGroup');

        if (model && !model.value) model.value = 'gemini-3.6-flash';
        if (apiKey) apiKey.placeholder = 'Paste a new Gemini API key';
        if (baseUrlGroup) baseUrlGroup.classList.add('d-none');
    }

    async loadAiOmrSettings() {
        try {
            const response = await this.apiCallWithAuth('/api/ai-omr/settings', {}, 'loadAiOmrSettings');
            this.renderAiOmrSettings(response.settings || {});
            this.loadAiOmrUsage();
        } catch (error) {
            console.error('Error loading AI OMR settings:', error);
        }
    }

    collectAiOmrSettings(clearApiKey = false) {
        const apiKey = document.getElementById('aiOmrApiKey')?.value || '';
        const instructionPromptEl = document.getElementById('aiOmrInstructionPrompt');
        const prompt = String(instructionPromptEl?.value || '').trim();
        if (!clearApiKey && instructionPromptEl && !prompt) {
            throw new Error('Scanner prompt cannot be blank.');
        }
        const payload = {
            enabled: true,
            provider: 'gemini',
            strategy: document.getElementById('aiOmrStrategy')?.value || 'auto',
            imageDetail: document.getElementById('aiOmrImageDetail')?.value || 'medium',
            verificationMode: document.getElementById('aiOmrVerificationMode')?.value || 'uncertain',
            model: document.getElementById('aiOmrModel')?.value || 'gemini-3.6-flash',
            baseUrl: document.getElementById('aiOmrBaseUrl')?.value || 'http://localhost:11434',
            sectionSize: Number.parseInt(document.getElementById('aiOmrSectionSize')?.value || '20', 10),
            timeoutMs: Number.parseInt(document.getElementById('aiOmrTimeoutMs')?.value || '30000', 10),
            maxRetries: Number.parseInt(document.getElementById('aiOmrMaxRetries')?.value || '2', 10),
            confidenceThreshold: Number.parseFloat(document.getElementById('aiOmrConfidenceThreshold')?.value || '0.75'),
            promptVersion: document.getElementById('aiOmrPromptVersion')?.value || 'omr-prompt-v1',
            apiKey: clearApiKey ? '' : apiKey,
            clearApiKey
        };
        if (instructionPromptEl && prompt) {
            payload.instructionPrompt = prompt;
        }
        return payload;
    }

    async saveAiOmrSettings(clearApiKey = false) {
        try {
            const payload = this.collectAiOmrSettings(clearApiKey);
            const response = await this.apiCallWithAuth('/api/ai-omr/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }, 'saveAiOmrSettings');
            this.renderAiOmrSettings(response.settings || {});
            this.toggleAiKeyReplace(false);
            this.showToast(clearApiKey ? 'Provider API key cleared.' : 'AI scanner settings saved.', 'success');
        } catch (error) {
            this.showToast(`AI scanner settings failed: ${error.message || error}`, 'danger');
        }
    }

    toggleAiKeyReplace(show) {
        const group = document.getElementById('aiOmrKeyInputGroup');
        const input = document.getElementById('aiOmrApiKey');
        if (group) group.classList.toggle('d-none', !show);
        if (input) {
            input.value = '';
            input.type = 'password';
            if (show) input.focus();
        }
    }

    restoreDefaultAiPrompt() {
        const textarea = document.getElementById('aiOmrInstructionPrompt');
        const version = document.getElementById('aiOmrPromptVersion');
        if (textarea) textarea.value = this.aiOmrDefaultPrompt || '';
        if (version) version.value = 'omr-prompt-v1';
        this.showToast('Default scanner prompt restored. Save settings to apply it.', 'info');
    }

    async testAiOmrConnection() {
        const btn = document.getElementById('aiOmrTestConnectionBtn');
        const previous = btn?.innerHTML;
        try {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Testing';
            }
            const response = await this.apiCallWithAuth('/api/ai-omr/test-connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: document.getElementById('aiOmrModel')?.value || undefined })
            }, 'testAiOmrConnection');
            if (response.success) {
                this.showToast('Gemini connection successful.', 'success');
                const badge = document.getElementById('aiOmrConnectionBadge');
                const status = document.getElementById('aiOmrStatusText');
                if (badge) {
                    badge.textContent = 'Gemini Connected';
                    badge.className = 'badge bg-success ms-auto';
                }
                if (status) status.textContent = 'Connected';
            } else {
                this.showToast(response.message || 'Connection failed. Check the API key, billing, or model configuration.', 'warning');
            }
        } catch (error) {
            this.showToast('Connection failed. Check the API key, billing, or model configuration.', 'danger');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = previous || '<i class="fas fa-plug me-1"></i> Test Connection';
            }
        }
    }

    async loadAiOmrUsage() {
        try {
            const response = await this.apiCallWithAuth('/api/ai-omr/usage', {}, 'loadAiOmrUsage');
            this.renderAiOmrUsage(response.usage || response || {});
        } catch (error) {
            this.renderAiOmrUsage(null);
        }
    }

    renderAiOmrUsage(usage) {
        const month = usage?.thisMonth || {};
        const average = usage?.average || {};
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value == null || value === '' ? '-' : String(value);
        };
        setText('aiOmrUsageMonthPapers', month.papers ?? month.scanCount ?? 0);
        setText('aiOmrUsageRequests', month.requests ?? month.requestCount ?? 0);
        const avgMs = Number(average.processingTimeMs ?? month.averageProcessingTimeMs ?? month.averageProcessingMs);
        setText('aiOmrUsageAvgProcessing', Number.isFinite(avgMs) && avgMs > 0 ? `${(avgMs / 1000).toFixed(1)} s` : '-');
        const tokens = Number(month.tokens ?? month.totalTokens);
        setText('aiOmrUsageTokens', Number.isFinite(tokens) && tokens > 0 ? tokens.toLocaleString() : '0');
    }

    setSystemBackupLog(message, isError = false) {
        const log = document.getElementById('systemBackupLog');
        if (!log) return;
        log.textContent = String(message || '').trim() || 'Ready.';
        log.classList.toggle('text-warning', Boolean(isError));
    }

    formatBytes(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = value;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index += 1;
        }
        return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    }

    async refreshSystemBackupHistory() {
        const container = document.getElementById('systemBackupHistory');
        if (!container) return;
        if (!this.isAuthenticated()) return;
        try {
            const response = await this.apiCallWithAuth('/api/system/backup/history', {}, 'loadBackupHistory');
            const backups = Array.isArray(response?.backups) ? response.backups : [];
            if (backups.length === 0) {
                container.textContent = 'No snapshots yet.';
                return;
            }

            container.innerHTML = backups.slice(0, 8).map((item) => {
                const fileName = escapeHtml(item.fileName || 'backup.zip');
                const size = this.formatBytes(item.sizeBytes);
                const dateText = item.modifiedAt ? new Date(item.modifiedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
                return `<div class="d-flex justify-content-between align-items-center py-2 px-3 border rounded-3 mb-2 bg-white">
                    <div class="d-flex align-items-center overflow-hidden">
                        <i class="far fa-file-archive text-primary me-3 fs-5"></i>
                        <div class="text-truncate">
                            <div class="fw-bold small text-truncate" title="${fileName}">${fileName}</div>
                            <div class="x-small text-muted">${dateText}</div>
                        </div>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <span class="badge bg-light text-muted border fw-normal">${size}</span>
                        <button class="btn btn-sm btn-outline-primary py-0 px-2" onclick="app.restoreFromHistory('${fileName}')" title="Restore this snapshot">
                            <i class="fas fa-history small"></i>
                        </button>
                    </div>
                </div>`;
        }).join('');
        this.updateInboxSelectionUI();
        } catch (error) {
            container.textContent = 'Unable to load snapshot history.';
        }
    }

    async downloadSystemBackup() {
        const token = localStorage.getItem('scancheck_token');
        if (!token) {
            this.handleUnauthorized();
            return;
        }
        this.setSystemBackupLog('Generating backup archive...');
        try {
            const url = scanCheckConfig.resolveUrl('/api/system/backup/download');
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            if (response.status === 401 || response.status === 403) {
                this.handleUnauthorized();
                return;
            }

            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const disposition = response.headers.get('content-disposition') || '';
            const fileNameMatch = disposition.match(/filename="?([^"]+)"?/i);
            const fileName = fileNameMatch?.[1] || `scancheck-backup-${Date.now()}.zip`;

            const urlObject = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = urlObject;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(urlObject);

            this.setSystemBackupLog(`Backup downloaded.\nFile: ${fileName}\nSize: ${this.formatBytes(blob.size)}`);
            this.showToast('Backup downloaded.', 'success');
            this.refreshSystemBackupHistory();
        } catch (error) {
            this.setSystemBackupLog(`Backup download failed.\n${error.message || error}`, true);
            this.showToast('Backup download failed.', 'danger');
        }
    }

    selectSystemBackupFile(file) {
        const selectedInfo = document.getElementById('systemBackupSelectedFile');
        const restoreBtn = document.getElementById('systemBackupRestoreBtn');
        const actionPanel = document.getElementById('restoreActionPanel');

        if (!file) {
            this.selectedSystemBackupFile = null;
            if (selectedInfo) selectedInfo.textContent = 'No backup file selected.';
            if (restoreBtn) restoreBtn.disabled = true;
            if (actionPanel) actionPanel.classList.add('d-none');
            return;
        }

        const isZip = String(file.name || '').toLowerCase().endsWith('.zip') || String(file.type || '').includes('zip');
        if (!isZip) {
            this.showToast('Please select a .zip backup file.', 'warning');
            this.selectedSystemBackupFile = null;
            if (selectedInfo) selectedInfo.textContent = 'Invalid file type. Select a .zip file.';
            if (restoreBtn) restoreBtn.disabled = true;
            if (actionPanel) actionPanel.classList.add('d-none');
            return;
        }

        this.selectedSystemBackupFile = file;
        if (selectedInfo) {
            selectedInfo.textContent = `${file.name} (${this.formatBytes(file.size)})`;
        }
        if (restoreBtn) restoreBtn.disabled = false;
        if (actionPanel) actionPanel.classList.remove('d-none');
    }

    async restoreFromLocalPath() {
        const input = document.getElementById('systemBackupLocalPath');
        const backupPath = input?.value?.trim();
        if (!backupPath) {
            this.showToast('Please enter an absolute path to a backup ZIP file.', 'warning');
            return;
        }

        const confirmRestore = confirm(`Restore from local path: ${backupPath}?\n\nWARNING: This will replace current system data using the ATOMIC SWAP method.`);
        if (!confirmRestore) return;

        this.setSystemBackupLog(`[${new Date().toLocaleTimeString()}] Initiating Local Path Restore...\nTarget: ${backupPath}`);
        
        try {
            const token = localStorage.getItem('scancheck_token');
            const response = await fetch(scanCheckConfig.resolveUrl('/api/system/backup/restore-path'), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ backupPath })
            });

            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Restore failed');

            this.setSystemBackupLog(`[${new Date().toLocaleTimeString()}] SUCCESS: Local Path Restore complete.\nRecords: ${payload.restoredCounts.records}\nScans: ${payload.restoredCounts.scans}`);
            this.showToast('System restored successfully from local path.', 'success');
            
            if (input) input.value = '';
            await this.handleRestoreSuccess();

        } catch (error) {
            this.setSystemBackupLog(`[${new Date().toLocaleTimeString()}] ERROR: ${error.message}`, true);
            this.showToast(`Local restore failed: ${error.message}`, 'danger');
        }
    }

    async restoreFromHistory(fileName) {
        const confirmRestore = confirm(`Restore from history snapshot: ${fileName}?\n\nWARNING: This will replace current system data using the ATOMIC SWAP method.`);
        if (!confirmRestore) return;

        this.setSystemBackupLog(`[${new Date().toLocaleTimeString()}] Initiating History Restore...\nSnapshot: ${fileName}`);
        
        try {
            const token = localStorage.getItem('scancheck_token');
            const response = await fetch(scanCheckConfig.resolveUrl('/api/system/backup/restore-history'), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ fileName })
            });

            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || 'Restore failed');

            this.setSystemBackupLog(`[${new Date().toLocaleTimeString()}] SUCCESS: History Restore complete.\nRecords: ${payload.restoredCounts.records}\nScans: ${payload.restoredCounts.scans}`);
            this.showToast('System restored successfully from snapshot.', 'success');
            
            await this.handleRestoreSuccess();

        } catch (error) {
            this.setSystemBackupLog(`[${new Date().toLocaleTimeString()}] ERROR: ${error.message}`, true);
            this.showToast(`History restore failed: ${error.message}`, 'danger');
        }
    }

    async handleRestoreSuccess() {
        this.records = [];
        this.scanResults = [];
        this._lastScanResultsSignature = '';
        this.renderRecords();
        this.renderScanResults();
        this.renderDashboard();
        await this.refreshSystemBackupHistory();
        await this.loadAllData();
        await this.refreshReports();
    }

    cleanupRestoreUI() {
        this.selectedSystemBackupFile = null;
        const restoreBtn = document.getElementById('systemBackupRestoreBtn');
        const fileInput = document.getElementById('systemBackupFileInput');
        const selectedInfo = document.getElementById('systemBackupSelectedFile');
        const actionPanel = document.getElementById('restoreActionPanel');
        const localPathInput = document.getElementById('systemBackupLocalPath');
        
        if (restoreBtn) restoreBtn.disabled = true;
        if (fileInput) fileInput.value = '';
        if (selectedInfo) selectedInfo.textContent = 'No backup file selected.';
        if (actionPanel) actionPanel.classList.add('d-none');
        if (localPathInput) localPathInput.value = '';
    }

    async restoreSystemBackup() {
        if (!this.selectedSystemBackupFile) {
            this.showToast('Choose a backup file first.', 'warning');
            return;
        }
        
        const fileName = this.selectedSystemBackupFile.name;
        const fileSize = this.formatBytes(this.selectedSystemBackupFile.size);
        
        const confirmRestore = confirm(`Restore backup "${fileName}" (${fileSize}) now?\n\nWARNING: Current data will be replaced. The system will create a pre-restore snapshot automatically.`);
        if (!confirmRestore) return;

        const token = localStorage.getItem('scancheck_token');
        if (!token) {
            this.handleUnauthorized();
            return;
        }

        const logLines = [];
        const addLog = (msg) => {
            const timestamp = new Date().toLocaleTimeString();
            logLines.push(`[${timestamp}] ${msg}`);
            this.setSystemBackupLog(logLines.join('\n'));
        };

        addLog(`Starting restoration process for: ${fileName}`);
        addLog(`File size: ${fileSize}`);
        
        try {
            addLog(`Initializing secure upload connection...`);
            const url = scanCheckConfig.resolveUrl('/api/system/backup/restore');
            
            addLog(`Uploading file: ${fileName} (${fileSize})`);
            addLog(`Streaming data directly to server...`);

            const xhr = new XMLHttpRequest();
            const CHUNK_SIZE = 128 * 1024 * 1024; // 128MB chunks
            const totalSize = this.selectedSystemBackupFile.size;
            const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

            if (totalSize > 500 * 1024 * 1024) {
                addLog(`Large file detected (${fileSize}). Switching to Chunked Upload mode...`);
                
                const fetchWithSafety = async (url, options) => {
                    const res = await fetch(url, options);
                    const contentType = res.headers.get('content-type') || '';
                    const text = await res.text();
                    
                    if (!contentType.includes('application/json')) {
                        const preview = text.substring(0, 200).replace(/</g, '&lt;');
                        throw new Error(`Server returned non-JSON response (${res.status} ${res.statusText}):\n${preview}...`);
                    }
                    
                    try {
                        return JSON.parse(text);
                    } catch (e) {
                        throw new Error(`Failed to parse JSON response: ${e.message}\nRaw response: ${text.substring(0, 100)}`);
                    }
                };

                // 1. Start session
                addLog(`Initializing chunked upload session...`);
                const startData = await fetchWithSafety(scanCheckConfig.resolveUrl('/api/system/backup/upload/start'), {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName, totalSize, totalChunks, chunkSize: CHUNK_SIZE })
                });

                const { uploadId } = startData;
                if (!uploadId) throw new Error('Failed to initialize upload session: No Upload ID received');

                // 2. Upload chunks
                for (let i = 0; i < totalChunks; i++) {
                    const start = i * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, totalSize);
                    const chunk = this.selectedSystemBackupFile.slice(start, end);
                    
                    addLog(`Uploading chunk ${i + 1}/${totalChunks} (${Math.round((i/totalChunks)*100)}%)...`);

                    await new Promise((resolve, reject) => {
                        const cXhr = new XMLHttpRequest();
                        cXhr.open('POST', scanCheckConfig.resolveUrl('/api/system/backup/upload/chunk'), true);
                        cXhr.setRequestHeader('Authorization', `Bearer ${token}`);
                        cXhr.setRequestHeader('X-Upload-Id', uploadId);
                        cXhr.setRequestHeader('X-Chunk-Index', i);
                        cXhr.setRequestHeader('X-Total-Chunks', totalChunks);
                        
                        cXhr.onload = () => {
                            const ct = cXhr.getResponseHeader('content-type') || '';
                            if (cXhr.status === 200 && ct.includes('application/json')) {
                                resolve();
                            } else {
                                let errorMsg = cXhr.responseText;
                                if (!ct.includes('application/json')) {
                                    errorMsg = `Server returned non-JSON response (${cXhr.status}): ${errorMsg.substring(0, 100)}...`;
                                } else {
                                    try { const json = JSON.parse(cXhr.responseText); errorMsg = json.error || errorMsg; } catch (e) {}
                                }
                                reject(new Error(errorMsg || `HTTP ${cXhr.status}`));
                            }
                        };
                        cXhr.onerror = () => reject(new Error('Network error during chunk upload'));
                        cXhr.send(chunk);
                    });
                }

                // 3. Complete
                addLog(`All chunks uploaded. Finalizing merge...`);
                await fetchWithSafety(scanCheckConfig.resolveUrl('/api/system/backup/upload/complete'), {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uploadId })
                });

                // 4. Restore
                addLog(`Merge complete. Initiating atomic restoration...`);
                const restoreData = await fetchWithSafety(scanCheckConfig.resolveUrl('/api/system/backup/restore-uploaded'), {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uploadId })
                });

                addLog(`SUCCESS: Chunked restoration complete.`);
                this.showToast('System restored successfully.', 'success');
                await this.handleRestoreSuccess();
                this.cleanupRestoreUI();
                return;
            }

            // Normal upload for smaller files
            addLog(`Uploading file: ${fileName} (${fileSize})`);
            addLog(`Streaming data directly to server...`);

            // Promise wrapper for XHR to maintain async flow
            const uploadPromise = new Promise((resolve, reject) => {
                xhr.open('POST', url, true);
                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');

                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const percent = Math.round((event.loaded / event.total) * 100);
                        if (percent % 5 === 0) { // Log every 5% to avoid spam
                            addLog(`Upload progress: ${percent}% (${this.formatBytes(event.loaded)} / ${fileSize})`);
                        }
                    }
                };

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve(xhr.responseText);
                    } else if (xhr.status === 401 || xhr.status === 403) {
                        addLog(`Error: Unauthorized access. Please log in again.`);
                        this.handleUnauthorized();
                        reject(new Error('Unauthorized'));
                    } else {
                        let errorMsg = 'Server Error';
                        try {
                            const payload = JSON.parse(xhr.responseText);
                            errorMsg = payload.error || xhr.responseText;
                        } catch (e) {
                            errorMsg = xhr.responseText || `HTTP ${xhr.status}`;
                        }
                        addLog(`Server Error: ${errorMsg}`);
                        reject(new Error(errorMsg));
                    }
                };

                xhr.onerror = () => {
                    addLog(`Network Error: The connection was reset or interrupted.`);
                    reject(new Error('Network connection failed. This can happen if the file is extremely large and the local network times out, or if the server crashed.'));
                };

                xhr.ontimeout = () => {
                    addLog(`Timeout Error: The upload took too long.`);
                    reject(new Error('Upload timed out.'));
                };

                // No timeout for massive 150GB+ files, let it run
                xhr.timeout = 0; 
                xhr.send(this.selectedSystemBackupFile);
            });

            const responseText = await uploadPromise;
            addLog(`Server received backup. Finalizing restoration...`);
            
            let payload = null;
            try {
                payload = responseText ? JSON.parse(responseText) : null;
            } catch (_error) {
                payload = null;
            }

            const snapshotName = payload?.preRestoreSnapshot || '-';
            const restoredRecords = payload?.restoredCounts?.records ?? 0;
            const restoredScans = payload?.restoredCounts?.scans ?? 0;
            
            addLog(`SUCCESS: Restoration complete.`);
            addLog(`-----------------------------------`);
            addLog(`Records Restored: ${restoredRecords}`);
            addLog(`Scans Restored:   ${restoredScans}`);
            addLog(`Snapshot Created: ${snapshotName}`);
            addLog(`-----------------------------------`);
            
            this.showToast('Backup restored successfully.', 'success');

            this.cleanupRestoreUI();

            // Refresh all local data to reflect restored state
            await this.handleRestoreSuccess();

        } catch (error) {
            console.error('Restore failed:', error);
            let detailedError = error.message;
            if (detailedError === 'Failed to fetch') {
                detailedError = 'Failed to fetch (Network Error). This usually happens if the file is too large for the network, the connection was interrupted, or the server crashed during processing.';
            }
            addLog(`CRITICAL FAILURE: ${detailedError}`);
            this.showToast(`Restore failed: ${error.message}`, 'danger');
        }
    }

    applyScannerViewSettings() {
        const showDeveloperPanels = localStorage.getItem('scancheck_show_developer_testing_panels') !== '0';
        const showRawData = localStorage.getItem('scancheck_show_raw_scan_data') !== '0';
        const showDebugView = localStorage.getItem('scancheck_show_omr_debug_view') !== '0';
        const effectiveShowRawData = showDeveloperPanels && showRawData;
        const effectiveShowDebugView = showDeveloperPanels && showDebugView;

        const rawDataToggle = document.getElementById('settingShowRawScanData');
        const debugViewToggle = document.getElementById('settingShowOmrDebugView');
        if (rawDataToggle) rawDataToggle.disabled = !showDeveloperPanels;
        if (debugViewToggle) debugViewToggle.disabled = !showDeveloperPanels;

        const rawSection = document.getElementById('ocrRawDataSection');
        const rawText = document.getElementById('ocrRawText');
        const rawToggleBtn = document.getElementById('ocrRawTextToggleBtn');
        if (rawSection) {
            rawSection.classList.toggle('d-none', !effectiveShowRawData);
        }
        if (rawText && rawToggleBtn) {
            if (effectiveShowRawData) {
                rawText.classList.remove('d-none');
                rawToggleBtn.textContent = 'Hide Raw Data';
            } else {
                rawText.classList.add('d-none');
                rawToggleBtn.textContent = 'Show Raw Data';
            }
        }

        const debugSection = document.getElementById('ocrDebugSection');
        if (debugSection) {
            debugSection.classList.toggle('d-none', !effectiveShowDebugView);
        }
    }

    getDefaultMultiSubjects() {
        return [
            { code: 'ENG', name: 'ENGLISH', questions: 20 },
            { code: 'SCI', name: 'SCIENCE', questions: 20 },
            { code: 'MATH', name: 'MATHEMATICS', questions: 20 },
            { code: 'GEN', name: 'GENERAL KNOWLEDGE', questions: 20 },
            { code: 'ABS', name: 'ABSTRACT REASONING', questions: 20 }
        ];
    }

    normalizeMultiSubjectDefinition(subjects) {
        const defaults = this.getDefaultMultiSubjects();
        const source = Array.isArray(subjects) && subjects.length > 0 ? subjects : defaults;
        const normalized = source
            .map((item, index) => {
                const fallback = defaults[index] || {};
                const code = String(item?.code || fallback.code || `SUB${index + 1}`).trim().toUpperCase();
                const name = String(item?.name || fallback.name || code).trim().toUpperCase();
                const questionsRaw = Number.parseInt(String(item?.questions ?? fallback.questions ?? 20), 10);
                const questions = Number.isFinite(questionsRaw) ? Math.min(100, Math.max(1, questionsRaw)) : 20;
                return { code, name, questions };
            })
            .filter((item) => item.code && item.name);

        return normalized.length > 0 ? normalized : defaults;
    }

    getSavedMultiSubjects() {
        const raw = localStorage.getItem('scancheck_multi_subjects');
        if (!raw) return this.getDefaultMultiSubjects();
        try {
            return this.normalizeMultiSubjectDefinition(JSON.parse(raw));
        } catch (error) {
            return this.getDefaultMultiSubjects();
        }
    }

    getSubjectConfigForQuiz(quizOrId = null, fallbackToSaved = true) {
        let quiz = null;
        if (quizOrId && typeof quizOrId === 'object') {
            quiz = quizOrId;
        } else if (quizOrId !== null && quizOrId !== undefined && quizOrId !== '') {
            quiz = this.quizzes.find((item) => String(item.id) === String(quizOrId)) || null;
        }
        const source = quiz?.subjectConfig || quiz?.subjects || (fallbackToSaved ? this.getSavedMultiSubjects() : this.getDefaultMultiSubjects());
        return this.normalizeMultiSubjectDefinition(source);
    }

    buildAnswerKeySubjectPlan(quizQuestionCount = 100, subjectConfig = null, format = 'multi-subject') {
        if (format === 'normal') {
            const targetTotal = Math.max(1, Math.min(100, Number.parseInt(String(quizQuestionCount || 100), 10) || 100));
            const sections = [{
                code: 'ALL',
                name: 'EXAM QUESTIONS',
                count: targetTotal,
                requested: targetTotal,
                startIndex: 1,
                endIndex: targetTotal
            }];
            return {
                sections,
                totalQuestions: targetTotal
            };
        }

        const defaults = this.getDefaultMultiSubjects();
        const configured = this.normalizeMultiSubjectDefinition(subjectConfig || this.getSavedMultiSubjects()).slice(0, 5);
        const subjects = (configured.length > 0 ? configured : defaults).map((item, index) => ({
            code: String(item?.code || defaults[index]?.code || `SUB${index + 1}`).trim().toUpperCase(),
            name: String(item?.name || defaults[index]?.name || `SUBJECT ${index + 1}`).trim().toUpperCase(),
            requested: Math.max(0, Math.min(20, Number.parseInt(String(item?.questions ?? 20), 10) || 0))
        }));

        const targetTotal = Math.max(1, Math.min(100, Number.parseInt(String(quizQuestionCount || 100), 10) || 100));
        let remaining = targetTotal;
        const sections = subjects.map((subject) => {
            const count = Math.min(subject.requested, remaining);
            remaining -= count;
            return {
                ...subject,
                count
            };
        });

        if (remaining > 0) {
            for (const section of sections) {
                if (remaining <= 0) break;
                const spare = Math.max(0, 20 - section.count);
                if (spare <= 0) continue;
                const add = Math.min(spare, remaining);
                section.count += add;
                remaining -= add;
            }
        }

        let cursor = 1;
        sections.forEach((section) => {
            section.startIndex = cursor;
            section.endIndex = cursor + Math.max(0, section.count) - 1;
            cursor = section.endIndex + 1;
        });

        return {
            sections,
            totalQuestions: cursor - 1
        };
    }

    normalizeQuizData(quizData = {}) {
        const normalized = { ...quizData };
        normalized.format = normalized.format || 'multi-subject';
        normalized.options = normalized.options || 4;
        const parsedCount = Number.parseInt(String(normalized.questionCount || 0), 10);
        normalized.questionCount = Number.isFinite(parsedCount)
            ? Math.min(100, Math.max(1, parsedCount))
            : 100;
        const parsedPassingScore = Number.parseInt(String(normalized.passingScore || PASSING_SCORE), 10);
        normalized.passingScore = Number.isFinite(parsedPassingScore)
            ? Math.min(100, Math.max(1, parsedPassingScore))
            : PASSING_SCORE;
        normalized.subjectConfig = this.getSubjectConfigForQuiz(normalized, true);
        return normalized;
    }

    applyQuizFormFormatRules() {
        const questionCountInput = document.getElementById('questionCount');
        if (!questionCountInput) return;

        questionCountInput.removeAttribute('readonly');
        questionCountInput.min = '1';
        questionCountInput.max = '100';
        if (!questionCountInput.value || Number(questionCountInput.value) <= 0) {
            questionCountInput.value = '100';
        }
    }

    isAuthenticated() {
        const token = localStorage.getItem('scancheck_token');
        return !!(token && token !== 'undefined' && token !== 'null');
    }

    async loadAllData() {
        loadingStateManager.showLoading('loadAllData', 'Loading system data...');
        try {
            // Load each data source separately so one failing request
            // does not abort the whole initialization flow.
            await this.loadQuizzes()
                .catch(e => console.error('loadQuizzes failed:', e));

            await this.loadScanResults()
                .catch(e => console.error('loadScanResults failed:', e));

            await this.loadRecords()
                .catch(e => console.error('loadRecords failed:', e));

            await this.loadSystems()
                .catch(e => console.error('loadSystems failed:', e));

            // Populate UI elements that are independent of the data.
            this.populateReportFilters();

            // Always render the dashboard – it will show “No recent activity”
            // if there are no scans, but at least the spinner disappears.
            this.renderDashboard();
        } finally {
            loadingStateManager.hideLoading('loadAllData');
        }
    }

    populateReportFilters() {
        const filter = document.getElementById('reportQuizFilter');
        const subjectFilter = document.getElementById('reportSubjectSelect');
        const entryFilter = document.getElementById('reportEntryFilter');
        const equityFilter = document.getElementById('reportEquityFilter');

        // Quiz filter
        if (filter) {
            const current = filter.value;
            filter.innerHTML = '<option value="">All Exams</option>' + 
                this.quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)}</option>`).join('');
            filter.value = current;
        }

        // Subject filter (populate once; preserve selection)
        if (subjectFilter && !subjectFilter.dataset.populated) {
            const current = subjectFilter.value;
            const subjectMap = new Map();
            (Array.isArray(this.quizzes) ? this.quizzes : []).forEach(q => {
                if (Array.isArray(q.subjectConfig)) {
                    q.subjectConfig.forEach(sub => {
                        if (!sub) return;
                        const code = String(sub.code || sub.name || '').trim();
                        if (code) subjectMap.set(code, sub.name || code);
                    });
                }
            });
            if (subjectMap.size > 0) {
                subjectFilter.innerHTML = '<option value="">All Subjects</option>' + 
                    [...subjectMap.entries()].map(([code, name]) => `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`).join('');
            }
            subjectFilter.value = current;
            subjectFilter.dataset.populated = '1';
        }

        // Entry type filter
        if (entryFilter && !entryFilter.dataset.populated) {
            const current = entryFilter.value;
            const entryTypes = ["New Student", "Transferee"];
            entryFilter.innerHTML = '<option value="">All Entry Types</option>' + 
                entryTypes.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
            entryFilter.value = current;
            entryFilter.dataset.populated = '1';
        }

        // Equity group filter
        if (equityFilter && !equityFilter.dataset.populated) {
            const current = equityFilter.value;
            const equityGroups = ["PWDs", "IPs", "Solo Parent", "Magna Carta"];
            equityFilter.innerHTML = '<option value="">All Equity Groups</option>' + 
                equityGroups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
            equityFilter.value = current;
            equityFilter.dataset.populated = '1';
        }
    }

    resetReportFilters() {
        ['reportQuizFilter', 'reportDateFrom', 'reportDateTo', 'reportEntryFilter', 'reportEquityFilter', 'reportRankingSort', 'reportSubjectSelect', 'reportMinScore'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        this.refreshReports();
    }

    async refreshReports() {
        const quizId = document.getElementById('reportQuizFilter')?.value || '';
        await this.loadScoreReport(quizId);
        if (window.subjectReportManager) {
            await window.subjectReportManager.loadSubjectReport();
        }
    }

    async loadScoreReport(quizFilter = '', dateFrom = '', dateTo = '') {
        try {
            const selectedQuizId = quizFilter || document.getElementById('reportQuizFilter')?.value || '';
            const selectedDateFrom = dateFrom || document.getElementById('reportDateFrom')?.value || '';
            const selectedDateTo = dateTo || document.getElementById('reportDateTo')?.value || '';
            const entryType = document.getElementById('reportEntryFilter')?.value || '';
            const equityGroup = document.getElementById('reportEquityFilter')?.value || '';
            
            let url = '/api/scores/report';
            const params = [];
            if (selectedQuizId) params.push(`quizId=${selectedQuizId}`);
            if (selectedDateFrom) params.push(`dateFrom=${selectedDateFrom}`);
            if (selectedDateTo) params.push(`dateTo=${selectedDateTo}`);
            if (entryType) params.push(`entryType=${entryType}`);
            if (equityGroup) params.push(`equityGroup=${equityGroup}`);
            
            if (params.length > 0) {
                url += '?' + params.join('&');
            }
            
            const report = await this.apiCallWithAuth(url, {}, 'loadScoreReport');
            let scans = report.scans || [];
            // ALWAYS enrich scans with record data (records = source of truth for course/dept)
            if (Array.isArray(this.records) && this.records.length > 0) {
                scans = scans.map(scan => {
                    const studentName = String(scan?.student_name || scan?.studentName || '').toLowerCase().trim();
                    const quizId = String(scan?.quiz_id || scan?.quizId || '');
                    if (studentName && quizId) {
                        const record = this.records.find(r =>
                            String(r.student_name || '').toLowerCase().trim() === studentName &&
                            String(r.quiz_id || r.quizId || '') === quizId
                        );
                        if (record) {
                            scan.course = record.course || scan.course || '';
                            scan.department = record.course || scan.department || '';
                        }
                    }
                    return scan;
                });
            }
            this.scanResults = scans;
            this.renderScoreReport({ ...report, scans });
        } catch (error) {
            console.error('Error loading score report:', error);
            // Error already handled by apiCallWithAuth
        }
    }

    renderScoreReport(report) {
        const container = document.getElementById('scoreReport');
        if (!container) return;

        const { scans, statistics } = report;
        const rankingSortMode = (document.getElementById('reportRankingSort')?.value || 'rank').toLowerCase();
        
        // Update summary stats in the main reports page
        const totalEl = document.getElementById('reportTotalStudents');
        const passRateEl = document.getElementById('reportPassRate');
        const avgScoreEl = document.getElementById('reportAvgScore');
        const totalExamsEl = document.getElementById('reportTotalExams');

        if (totalEl) totalEl.textContent = statistics.totalStudents || 0;
        if (passRateEl) passRateEl.textContent = `${statistics.studentPassRate || 0}%`;
        if (avgScoreEl) avgScoreEl.textContent = `${statistics.avgPercentage || 0}%`;
        if (totalExamsEl) totalExamsEl.textContent = [...new Set(scans.map(s => s.quiz_id))].length;

        const subjectRanking = this.buildOverallSubjectRankingFromScans(scans || [], rankingSortMode);
        const departmentRanking = this.buildDepartmentRankingFromScans(scans || [], rankingSortMode);
        
        container.innerHTML = `
            <div class="row g-4 mb-4">
                <div class="col-lg-6">
                    <div class="card h-100 border-0 shadow-sm rounded-4">
                        <div class="card-header bg-white py-3 border-0">
                            <h6 class="mb-0 fw-bold text-dark"><i class="fas fa-chart-bar me-2 text-primary"></i>Subject Performance</h6>
                        </div>
                        <div class="card-body" style="height: 300px;">
                            <canvas id="subjectChart"></canvas>
                        </div>
                    </div>
                </div>
                <div class="col-lg-6">
                    <div class="card h-100 border-0 shadow-sm rounded-4">
                        <div class="card-header bg-white py-3 border-0">
                            <h6 class="mb-0 fw-bold text-dark"><i class="fas fa-chart-bar me-2 text-primary"></i>Course / Department</h6>
                        </div>
                        <div class="card-body" style="height: 300px;">
                            <canvas id="departmentChart"></canvas>
                        </div>
                    </div>
                </div>
            </div>

            <div class="row g-4 mb-4">
                <div class="col-lg-6">
                    <div class="card h-100 border-0 shadow-sm rounded-4">
                        <div class="card-header bg-white py-3 border-0">
                            <h6 class="mb-0 fw-bold text-dark"><i class="fas fa-ranking-star me-2 text-primary"></i>Subject Ranking</h6>
                        </div>
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0">
                                <thead class="table-light">
                                    <tr class="x-small text-uppercase text-muted">
                                        <th class="ps-4">Rank</th>
                                        <th>Subject</th>
                                        <th class="text-end">Avg %</th>
                                        <th class="text-end pe-4">Takers</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${subjectRanking.length === 0 ? '<tr><td colspan="4" class="text-center text-muted py-4">No data</td></tr>' :
                                        subjectRanking.map((row) => `
                                            <tr>
                                                <td class="ps-4"><span class="badge bg-primary bg-opacity-10 text-primary">${row.rank}</span></td>
                                                <td class="small fw-bold">${escapeHtml(row.subject)}</td>
                                                <td class="text-end fw-bold text-primary">${row.avg.toFixed(1)}%</td>
                                                <td class="text-end pe-4 small text-muted">${row.takers}</td>
                                            </tr>
                                        `).join('')
                                    }
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
                <div class="col-lg-6">
                    <div class="card h-100 border-0 shadow-sm rounded-4">
                        <div class="card-header bg-white py-3 border-0">
                            <h6 class="mb-0 fw-bold text-dark"><i class="fas fa-building me-2 text-primary"></i>Department Ranking</h6>
                        </div>
                        <div class="table-responsive">
                            <table class="table table-hover align-middle mb-0">
                                <thead class="table-light">
                                    <tr class="x-small text-uppercase text-muted">
                                        <th class="ps-4">Rank</th>
                                        <th>Department</th>
                                        <th class="text-end">Avg %</th>
                                        <th class="text-end pe-4">Takers</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${departmentRanking.length === 0 ? '<tr><td colspan="4" class="text-center text-muted py-4">No data</td></tr>' :
                                        departmentRanking.map((row) => `
                                            <tr>
                                                <td class="ps-4"><span class="badge bg-primary bg-opacity-10 text-primary">${row.rank}</span></td>
                                                <td class="small fw-bold">${escapeHtml(app.getShortDepartmentName(row.department))}</td>
                                                <td class="text-end fw-bold text-success">${row.avg.toFixed(1)}%</td>
                                                <td class="text-end pe-4 small text-muted">${row.takers}</td>
                                            </tr>
                                        `).join('')
                                    }
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card border-0 shadow-sm rounded-4 overflow-hidden">
                <div class="card-header bg-white py-3 border-0 d-flex justify-content-between align-items-center">
                    <h6 class="mb-0 fw-bold text-dark"><i class="fas fa-list-ul me-2 text-primary"></i>Student Results Breakdown</h6>
                    <button class="btn btn-sm btn-outline-primary rounded-pill" onclick="app.exportScoresToCSV()">
                        <i class="fas fa-download me-1"></i> Export Results
                    </button>
                </div>
                <div class="table-responsive">
                    <table class="table table-hover align-middle mb-0">
                        <thead class="table-light">
                            <tr class="x-small text-uppercase text-muted">
                                <th class="ps-4">Student Name</th>
                                <th>Exam / Course</th>
                                <th>Score</th>
                                <th>Percentage</th>
                                <th>Status</th>
                                <th class="text-end pe-4">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${scans.length === 0 ? '<tr><td colspan="6" class="text-center py-5">No results found matching your filters.</td></tr>' : 
                              scans.map(scan => `
                                <tr>
                                    <td class="ps-4">
                                        <div class="fw-bold text-dark">${escapeHtml(scan.student_name)}</div>
                                        <div class="x-small text-muted">${new Date(scan.timestamp).toLocaleDateString()}</div>
                                    </td>
                                    <td>
                                        <div class="small fw-bold text-dark">${escapeHtml(scan.quiz_title || 'Exam ' + scan.quiz_id)}</div>
                                        <div class="x-small text-muted">${escapeHtml(scan.course || 'Unassigned')}</div>
                                    </td>
                                    <td>
                                        <span class="small fw-bold">${scan.score} / ${scan.total_questions}</span>
                                    </td>
                                    <td>
                                        <div class="d-flex align-items-center gap-2">
                                            <div class="progress flex-grow-1" style="height: 4px; min-width: 60px;">
                                                <div class="progress-bar bg-${scan.percentage >= PASSING_SCORE ? 'success' : 'danger'}" style="width: ${scan.percentage}%"></div>
                                            </div>
                                            <span class="small fw-bold">${scan.percentage}%</span>
                                        </div>
                                    </td>
                                    <td>
                                        <span class="badge bg-${scan.percentage >= PASSING_SCORE ? 'success' : 'danger'} bg-opacity-10 text-${scan.percentage >= PASSING_SCORE ? 'success' : 'danger'} border border-${scan.percentage >= PASSING_SCORE ? 'success' : 'danger'} border-opacity-10 x-small">
                                            ${scan.percentage >= PASSING_SCORE ? 'PASS' : 'FAIL'}
                                        </span>
                                    </td>
                                    <td class="text-end pe-4">
                                        <button class="btn btn-sm btn-light rounded-circle" onclick="app.showDetailedResults(${scan.id})">
                                            <i class="fas fa-eye text-primary"></i>
                                        </button>
                                    </td>
                                </tr>
                              `).join('')
                            }
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        // Render charts after DOM is updated
        setTimeout(() => {
            this.renderCharts(subjectRanking, departmentRanking);
        }, 100);
    }

    renderCharts(subjectRanking, departmentRanking) {
        // Destroy existing chart instances to prevent memory leaks
        if (this._reportCharts) {
            this._reportCharts.forEach(c => { try { c.destroy(); } catch(e) {} });
        }
        this._reportCharts = [];

        // Subject Chart
        const subjectCtx = document.getElementById('subjectChart');
        if (subjectCtx && subjectRanking.length > 0 && typeof Chart !== 'undefined') {
            const colors = [
                'rgba(13, 110, 253, 0.75)', 'rgba(111, 66, 193, 0.75)',
                'rgba(13, 202, 240, 0.75)', 'rgba(255, 193, 7, 0.75)',
                'rgba(25, 135, 84, 0.75)', 'rgba(220, 53, 69, 0.75)',
                'rgba(253, 126, 20, 0.75)', 'rgba(32, 201, 151, 0.75)'
            ];
            const chart = new Chart(subjectCtx, {
                type: 'bar',
                data: {
                    labels: subjectRanking.map(r => r.subject),
                    datasets: [
                        {
                            label: 'Average Score (%)',
                            data: subjectRanking.map(r => r.avg),
                            backgroundColor: subjectRanking.map((_, i) => colors[i % colors.length]),
                            borderColor: subjectRanking.map((_, i) => colors[i % colors.length].replace('0.75', '1')),
                            borderWidth: 1,
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
            this._reportCharts.push(chart);
        } else if (subjectCtx) {
            this._showChartEmpty(subjectCtx, 'No subject performance data available');
        }

        // Department Chart
        const departmentCtx = document.getElementById('departmentChart');
        if (departmentCtx && departmentRanking.length > 0 && typeof Chart !== 'undefined') {
            const deptColors = [
                'rgba(220, 53, 69, 0.75)', 'rgba(13, 110, 253, 0.75)',
                'rgba(25, 135, 84, 0.75)', 'rgba(255, 193, 7, 0.75)',
                'rgba(111, 66, 193, 0.75)', 'rgba(253, 126, 20, 0.75)',
                'rgba(32, 201, 151, 0.75)', 'rgba(108, 117, 125, 0.6)'
            ];
            const chart = new Chart(departmentCtx, {
                type: 'bar',
                data: {
                    labels: departmentRanking.map(r => this.getShortDepartmentName(r.department)),
                    datasets: [
                        {
                            label: 'Average Score (%)',
                            data: departmentRanking.map(r => r.avg),
                            backgroundColor: departmentRanking.map((r, i) =>
                                r.department === 'Unassigned'
                                    ? 'rgba(108, 117, 125, 0.6)'
                                    : deptColors[i % (deptColors.length - 1)]
                            ),
                            borderColor: departmentRanking.map((r, i) =>
                                r.department === 'Unassigned'
                                    ? 'rgba(108, 117, 125, 1)'
                                    : deptColors[i % (deptColors.length - 1)].replace('0.75', '1')
                            ),
                            borderWidth: 1,
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
            this._reportCharts.push(chart);
        } else if (departmentCtx) {
            this._showChartEmpty(departmentCtx, 'No department performance data available');
        }
    }

    _showChartEmpty(canvas, message) {
        canvas.style.display = 'none';
        const parent = canvas.parentElement;
        if (parent && !parent.querySelector('.chart-empty-placeholder')) {
            const div = document.createElement('div');
            div.className = 'chart-empty-placeholder d-flex flex-column align-items-center justify-content-center text-muted';
            div.style.cssText = 'min-height: 250px;';
            div.innerHTML = `<i class="fas fa-chart-bar mb-2" style="font-size: 2rem; opacity: 0.3;"></i><span class="small">${message}</span>`;
            parent.appendChild(div);
        }
    }

    // Build subject ranking using the dynamic `subject_scores` JSON from each scan.
    // This replaces the old static *_percentage column logic.
    buildOverallSubjectRankingFromScans(scans = [], sortMode = 'rank') {
        // Aggregate per‑subject data from the `subject_scores` JSON stored on each scan.
        // The structure of `subject_scores` is:
        //   { "CODE": { percentage: number, status: string, score: number, total: number, ... }, ... }
        // We compute total percentage, number of takers, pass count, best percentage and top student.
        const subjectMap = new Map();
        for (const scan of scans) {
            // Parse JSON if needed (it may already be an object).
            let scoresObj = scan.subject_scores;
            if (typeof scoresObj === 'string') {
                try { scoresObj = JSON.parse(scoresObj); } catch (_) { scoresObj = {}; }
            }
            if (!scoresObj || typeof scoresObj !== 'object') continue;
            const quizId = scan.quiz_id || scan.quizId;
            const passingScore = (() => {
                if (!quizId) return PASSING_SCORE;
                const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                return (quiz && quiz.passingScore) ? quiz.passingScore : PASSING_SCORE;
            })();
            for (const [code, data] of Object.entries(scoresObj)) {
                // Tolerate legacy flat format where the value is a raw number instead
                // of an object { percentage, status, score, total }.
                // Legacy values were either percentages (usually > 20, up to 100) or scores (0-20).
                const isNested = data && typeof data === 'object';
                let pct;
                if (isNested) {
                    pct = Number(data.percentage);
                } else {
                    const raw = Number(data);
                    pct = Number.isFinite(raw) && raw > 0 ? (raw > 20 ? raw : (raw / 20) * 100) : NaN;
                }
                if (!Number.isFinite(pct) || pct === 0) continue; // skip zero‑score takers
                const status = normalizeScanStatus(isNested ? data.status : null, pct, passingScore);
                const passed = status === 'PASS' ? 1 : 0;
                const studentName = String(scan.student_name || scan.studentName || '').trim() || 'N/A';
                if (!subjectMap.has(code)) {
                    subjectMap.set(code, {
                        code,
                        total: 0,
                        takers: 0,
                        pass: 0,
                        bestPct: -1,
                        topStudent: ''
                    });
                }
                const entry = subjectMap.get(code);
                entry.total += pct;
                entry.takers += 1;
                entry.pass += passed;
                if (pct > entry.bestPct) {
                    entry.bestPct = pct;
                    entry.topStudent = studentName;
                }
            }
        }
        // Resolve friendly labels from the current quiz's subjectConfig if available.
        const currentQuizId = document.getElementById('quizSelect')?.value || '';
        const currentQuiz = this.quizzes.find(q => String(q.id) === String(currentQuizId));
        const configMap = new Map();
        if (currentQuiz && Array.isArray(currentQuiz.subjectConfig)) {
            for (const sub of currentQuiz.subjectConfig) {
                const code = String(sub.code || sub.name || '').trim();
                if (code) configMap.set(code, sub.name || code);
            }
        }
        // Build rows array.
        const rows = [];
        for (const entry of subjectMap.values()) {
            const label = configMap.get(entry.code) || entry.code;
            rows.push({
                subject: `${entry.code} - ${label}`,
                avg: entry.total / entry.takers,
                passRate: (entry.pass / entry.takers) * 100,
                takers: entry.takers,
                topStudent: entry.topStudent
            });
        }
        // Sort according to requested mode.
        this.sortRankingRows(rows, sortMode, 'subject');
        // Return rows with rank numbers.
        return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
        return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
    }

    getShortDepartmentName(name) {
        const deptMap = {
            'Normal Entrance Exam': 'Entrance',
            'Bachelor of Science in Criminology': 'Criminology',
            'Bachelor of Elementary Education': 'Elem. Ed',
            'Bachelor of Secondary Education': 'Sec. Ed',
            'Bachelor of Science in Hospitality Management': 'Hospitality',
            'Bachelor of Science in Business Administration': 'Business',
            'Bachelor of Science in Information Technology': 'IT',
            'Unassigned': 'Unassigned'
        };
        return deptMap[name] || name;
    }

    normalizeDepartment(raw) {
        if (!raw || String(raw).trim() === '') return 'Unassigned';
        const val = String(raw).trim();
        const shortMap = {
            'BSIT': 'Bachelor of Science in Information Technology',
            'BSEd': 'Bachelor of Secondary Education',
            'BSCrim': 'Bachelor of Science in Criminology',
            'BSBA': 'Bachelor of Science in Business Administration',
            'BSHM': 'Bachelor of Science in Hospitality Management',
            'BEED': 'Bachelor of Elementary Education',
            'BEEd': 'Bachelor of Elementary Education',
            'BSED': 'Bachelor of Secondary Education',
            'CRIM': 'Bachelor of Science in Criminology',
            'IT': 'Bachelor of Science in Information Technology',
            'HOSPITALITY': 'Bachelor of Science in Hospitality Management',
            'BUSINESS': 'Bachelor of Science in Business Administration',
            'ELEM': 'Bachelor of Elementary Education',
        };
        const upper = val.toUpperCase();
        if (shortMap[upper]) return shortMap[upper];
        const fullNames = this.getDepartmentMasterList();
        if (fullNames.includes(val)) return val;
        return val;
    }

    getDepartmentMasterList() {
        return [
            'Normal Entrance Exam',
            'Bachelor of Science in Criminology',
            'Bachelor of Elementary Education',
            'Bachelor of Secondary Education',
            'Bachelor of Science in Hospitality Management',
            'Bachelor of Science in Business Administration',
            'Bachelor of Science in Information Technology'
        ];
    }

    buildDepartmentRankingFromScans(scans = [], sortMode = 'rank') {
        const map = new Map();
        for (const scan of scans) {
            const department = this.normalizeDepartment(scan?.department || scan?.course);
            const percentage = Number.parseFloat(scan?.percentage);
            if (!Number.isFinite(percentage)) continue;
            if (!map.has(department)) {
                map.set(department, { department, total: 0, takers: 0, pass: 0, bestPct: -1, topStudent: '' });
            }
            const row = map.get(department);
            row.total += percentage;
            row.takers += 1;
            
            let passingScore = 75;
            const quizId = scan?.quiz_id || scan?.quizId;
            if (quizId) {
                const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                if (quiz && quiz.passingScore) {
                    passingScore = quiz.passingScore;
                }
            }
            
            if (normalizeScanStatus(scan?.status, percentage, passingScore) === 'PASS') row.pass += 1;
            if (percentage > row.bestPct) {
                row.bestPct = percentage;
                row.topStudent = String(scan?.student_name || scan?.studentName || 'N/A').trim() || 'N/A';
            }
        }

        // Seed all known departments so they appear even with zero scans
        const masterList = this.getDepartmentMasterList();
        for (const dept of masterList) {
            if (!map.has(dept)) {
                map.set(dept, { department: dept, total: 0, takers: 0, pass: 0, bestPct: 0, topStudent: '' });
            }
        }
        // 'Unassigned' is NOT seeded here — it only appears via normalizeDepartment()
        // when a scan actually has an empty/missing department/course field.

        const rows = Array.from(map.values()).map((row) => ({
            department: row.department,
            avg: row.takers ? row.total / row.takers : 0,
            passRate: row.takers ? (row.pass / row.takers) * 100 : 0,
            takers: row.takers,
            topStudent: row.topStudent
        }));

        if (sortMode !== 'alpha') {
            rows.sort((a, b) => {
                if (a.department === 'Unassigned' && b.department !== 'Unassigned') return 1;
                if (b.department === 'Unassigned' && a.department !== 'Unassigned') return -1;
                const aKnown = masterList.includes(a.department);
                const bKnown = masterList.includes(b.department);
                if (aKnown && !bKnown) return -1;
                if (!aKnown && bKnown) return 1;
                if (Number(b.avg) !== Number(a.avg)) return Number(b.avg) - Number(a.avg);
                if (Number(b.passRate) !== Number(a.passRate)) return Number(b.passRate) - Number(a.passRate);
                const bCount = Number(b.takers || 0);
                const aCount = Number(a.takers || 0);
                if (bCount !== aCount) return bCount - aCount;
                return String(a.department).localeCompare(String(b.department));
            });
        } else {
            this.sortRankingRows(rows, sortMode, 'department');
        }
        return rows.map((row, idx) => ({ ...row, rank: idx + 1 }));
    }

    sortRankingRows(rows = [], sortMode = 'rank', entity = 'generic') {
        const mode = String(sortMode || 'rank').toLowerCase();
        if (mode === 'alpha') {
            if (entity === 'subject') {
                rows.sort((a, b) => String(a.subject || '').localeCompare(String(b.subject || ''), undefined, { sensitivity: 'base' }));
            } else if (entity === 'department') {
                rows.sort((a, b) => String(a.department || '').localeCompare(String(b.department || ''), undefined, { sensitivity: 'base' }));
            } else if (entity === 'student') {
                rows.sort((a, b) => String(a.studentName || '').localeCompare(String(b.studentName || ''), undefined, { sensitivity: 'base' }));
            }
            return;
        }

        rows.sort((a, b) => {
            if (Number(b.avg) !== Number(a.avg)) return Number(b.avg) - Number(a.avg);
            if (Number(b.passRate) !== Number(a.passRate)) return Number(b.passRate) - Number(a.passRate);
            const bCount = Number(b.takers || b.exams || 0);
            const aCount = Number(a.takers || a.exams || 0);
            if (bCount !== aCount) return bCount - aCount;
            const nameA = String(a.studentName || a.subject || a.department || '');
            const nameB = String(b.studentName || b.subject || b.department || '');
            return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
        });
    }

    exportScoresToCSV() {
        if (!this.scanResults || this.scanResults.length === 0) {
            this.showToast('No data to export', 'warning');
            return;
        }

        const csvContent = "data:text/csv;charset=utf-8," + 
            "Student,Entry Type,Equity Group,Exam,Score,Total Questions,Percentage,Status,Date\n" + 
            this.scanResults.map(scan => {
                const name = scan.studentName || scan.student_name || 'Anonymous';
                const entryType = scan.entry_type || 'New Student';
                const equityGroup = scan.special_equity_group || 'None';
                const title = scan.quizTitle || scan.quiz_title || 'Unknown Exam';
                
                // Get the quiz's passing score if available, default to 75
                let passingScore = 75;
                const quizId = scan?.quiz_id || scan?.quizId;
                if (quizId) {
                    const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                    if (quiz && quiz.passingScore) {
                        passingScore = quiz.passingScore;
                    }
                }
                
                const status = normalizeScanStatus(scan.status, scan.percentage, passingScore);
                return `"${name}","${entryType}","${equityGroup}","${title}",${scan.score},${scan.total_questions || scan.totalQuestions},${scan.percentage},${status},"${scan.timestamp}"`;
            }).join("\n");
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "score_report_" + new Date().toISOString().split('T')[0] + ".csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    async loadSystemInfo() {
        try {
            const info = await this.apiCallWithAuth('/api/system/info', {}, 'loadSystemInfo');
            if (info && info.url) {
                const urlInput = document.getElementById('networkUrlInput');
                if (urlInput) urlInput.value = info.url;
                this.networkUrl = info.url;
            }

            // Update Dashboard IP
            const mobileIpBadge = document.getElementById('mobileConnectionIp');
            const serverIpSpan = document.getElementById('serverIpAddress');
            if (mobileIpBadge && serverIpSpan && info && info.ip) {
                const displayIp = info.port ? `${info.ip}:${info.port}` : info.ip;
                serverIpSpan.textContent = displayIp;
                mobileIpBadge.classList.remove('d-none');
            }
        } catch (error) {
            console.error('Error loading system info:', error);
        }
    }

    renderDashboard() {
        const statQuizzes = document.getElementById('statQuizzes');
        const statScans = document.getElementById('statScans');
        const statAvgScore = document.getElementById('statAvgScore');
        const statPassRate = document.getElementById('statPassRate');
        const statRecords = document.getElementById('statRecords');
        const recentList = document.getElementById('recentScansList');
        const insightsContainer = document.getElementById('dashboardInsights');

        if (!statQuizzes) return;

        // Stats
        statQuizzes.textContent = this.quizzes.length;
        statScans.textContent = this.scanResults.length;
        if (statRecords) statRecords.textContent = this.records.length;

        if (this.scanResults.length > 0) {
            const totalPct = this.scanResults.reduce((acc, s) => acc + (Number(s.percentage) || 0), 0);
            const avg = totalPct / this.scanResults.length;
            statAvgScore.textContent = `${avg.toFixed(1)}%`;

            const passed = this.scanResults.filter(s => {
                let passingScore = 75;
                const quizId = s?.quiz_id || s?.quizId;
                if (quizId) {
                    const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                    if (quiz && quiz.passingScore) passingScore = quiz.passingScore;
                }
                return (Number(s.percentage) || 0) >= passingScore;
            }).length;
            const passRate = (passed / this.scanResults.length) * 100;
            statPassRate.textContent = `${passRate.toFixed(0)}%`;
        } else {
            statAvgScore.textContent = '0%';
            statPassRate.textContent = '0%';
        }

        // Recent Scans
        if (this.scanResults.length === 0) {
            recentList.innerHTML = `
                <div class="empty-state py-5">
                    <i class="fas fa-history empty-state-icon"></i>
                    <h6 class="empty-state-title">No recent activity</h6>
                    <p class="empty-state-description small">Scan results will appear here after processing answer sheets.</p>
                </div>
            `;
        } else {
            const recent = this.scanResults.slice(0, 5);
            recentList.innerHTML = `
                <div class="table-responsive">
                    <table class="table table-hover align-middle mb-0">
                        <thead class="table-light">
                            <tr class="x-small text-uppercase text-muted">
                                <th class="ps-4">Student</th>
                                <th>Exam</th>
                                <th>Score</th>
                                <th>Status</th>
                                <th class="text-end pe-4">Date</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${recent.map(scan => {
                                // Get the quiz's passing score if available, default to 75
            let passingScore = PASSING_SCORE;
                                const quizId = scan?.quiz_id || scan?.quizId;
                                if (quizId) {
                                    const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                                    if (quiz && quiz.passingScore) {
                                        passingScore = quiz.passingScore;
                                    }
                                }
                                
                                const needsReview = scan.review_status === 'needs_review' || (scan.percentage < passingScore && scan.review_status === 'auto_scanned');
                                const pct = Number(scan.percentage) || 0;
                                return `
                                <tr>
                                    <td class="ps-4">
                                        <div class="fw-bold text-dark">${escapeHtml(scan.studentName || scan.student_name || 'Student')}</div>
                                    </td>
                                    <td>
                                        <div class="small text-muted">${escapeHtml(scan.quizTitle || 'Entrance Exam')}</div>
                                    </td>
                                    <td>
                                        <div class="small fw-bold text-dark">${pct.toFixed(1)}%</div>
                                    </td>
                                    <td>
                                        <span class="badge rounded-pill bg-${pct >= passingScore ? 'success' : 'danger'} bg-opacity-10 text-${pct >= passingScore ? 'success' : 'danger'} border border-${pct >= passingScore ? 'success' : 'danger'} border-opacity-10 x-small">
                                            ${pct >= passingScore ? 'PASS' : 'FAIL'}
                                        </span>
                                        ${needsReview ? '<span class="badge bg-warning text-dark x-small ms-1"><i class="fas fa-exclamation-triangle"></i></span>' : ''}
                                    </td>
                                    <td class="text-end pe-4">
                                        <div class="x-small text-muted">${scan.timestamp ? new Date(scan.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'Today'}</div>
                                    </td>
                                </tr>
                            `}).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        // Analytics
        if (insightsContainer) {
            const scans = Array.isArray(this.scanResults) ? this.scanResults : [];
            const total = scans.length;
            const passing = scans.filter((scan) => {
                // Get the quiz's passing score if available, default to 75
                let passingScore = 75;
                const quizId = scan?.quiz_id || scan?.quizId;
                if (quizId) {
                    const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                    if (quiz && quiz.passingScore) {
                        passingScore = quiz.passingScore;
                    }
                }
                return normalizeScanStatus(scan?.status, Number(scan?.percentage) || 0, passingScore) === 'PASS';
            }).length;
            const failing = Math.max(0, total - passing);
            const passRate = total > 0 ? ((passing / total) * 100) : 0;

            const subjectRanking = this.buildOverallSubjectRankingFromScans(scans, 'rank').slice(0, 3);
            const departmentRanking = this.buildDepartmentRankingFromScans(scans, 'rank');
            
            // Top Students ranking
            const topStudents = [...(this.records || [])]
                .sort((a, b) => (Number(b.percentage) || 0) - (Number(a.percentage) || 0))
                .slice(0, 3);

            insightsContainer.innerHTML = `
                <div class="card shadow-sm border-0 rounded-4 overflow-hidden h-100">
                    <div class="card-header bg-white border-0 py-3 d-flex justify-content-between align-items-center">
                        <h6 class="mb-0 fw-bold text-dark"><i class="fas fa-chart-pie text-primary me-2"></i>Performance Insights</h6>
                        <a href="#/reports" class="btn btn-sm btn-light rounded-pill px-3">View Full Reports</a>
                    </div>
                    <div class="card-body p-4">
                        <div class="row g-4">
                            <div class="col-md-4">
                                <h6 class="x-small fw-bold text-muted text-uppercase mb-3">Top Subjects</h6>
                                ${subjectRanking.length === 0 ? '<div class="small text-muted py-3 text-center">No data available</div>' : `
                                    <div class="d-flex flex-column gap-3">
                                        ${subjectRanking.map(row => `
                                            <div class="d-flex justify-content-between align-items-center">
                                                <div class="small fw-bold text-dark text-truncate" title="${escapeHtml(row.subject)}">${escapeHtml(row.subject.split(' - ')[1] || row.subject)}</div>
                                                <div class="small fw-bold text-primary">${row.avg.toFixed(1)}%</div>
                                            </div>
                                            <div class="progress" style="height: 4px;">
                                                <div class="progress-bar bg-primary" style="width: ${row.avg}%"></div>
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                            <div class="col-md-4">
                                <h6 class="x-small fw-bold text-muted text-uppercase mb-3">Top Departments</h6>
                                ${departmentRanking.length === 0 ? '<div class="small text-muted py-3 text-center">No data available</div>' : `
                                    <div class="d-flex flex-column gap-3">
                                        ${departmentRanking.map(row => `
                                            <div class="d-flex justify-content-between align-items-center">
                                                <div class="small fw-bold text-dark text-truncate" title="${escapeHtml(row.department)}">${escapeHtml(app.getShortDepartmentName(row.department))}</div>
                                                <div class="small fw-bold text-success">${row.avg.toFixed(1)}%</div>
                                            </div>
                                            <div class="progress" style="height: 4px;">
                                                <div class="progress-bar bg-success" style="width: ${row.avg}%"></div>
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                            <div class="col-md-4">
                                <h6 class="x-small fw-bold text-muted text-uppercase mb-3">Top Students</h6>
                                ${topStudents.length === 0 ? '<div class="small text-muted py-3 text-center">No data available</div>' : `
                                    <div class="d-flex flex-column gap-3">
                                        ${topStudents.map(student => `
                                            <div class="d-flex justify-content-between align-items-center">
                                                <div class="small fw-bold text-dark text-truncate" title="${escapeHtml(student.student_name)}">${escapeHtml(student.student_name)}</div>
                                                <div class="small fw-bold text-info">${Number(student.percentage).toFixed(1)}%</div>
                                            </div>
                                            <div class="progress" style="height: 4px;">
                                                <div class="progress-bar bg-info" style="width: ${student.percentage}%"></div>
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        // Render Dashboard Charts
        this.renderDashboardCharts();
    }

    renderDashboardCharts() {
        // Destroy existing dashboard chart instances
        if (this._dashboardCharts) {
            this._dashboardCharts.forEach(c => { try { c.destroy(); } catch(e) {} });
        }
        this._dashboardCharts = [];

        // Use scans first, fall back to records (saved student data)
        let dataSource = Array.isArray(this.scanResults) && this.scanResults.length > 0
            ? this.scanResults
            : (Array.isArray(this.records) && this.records.length > 0 ? this.records : []);

        const scoreCtx = document.getElementById('dashboardScoreChart');
        const activityCtx = document.getElementById('dashboardActivityChart');

        // ---- If no data at all, show placeholder messages ----
        if (dataSource.length === 0) {
            [scoreCtx, activityCtx].forEach(canvas => {
                if (!canvas) return;
                const parent = canvas.parentElement;
                const existing = parent.querySelector('.chart-empty-state');
                if (existing) existing.remove();
                const placeholder = document.createElement('div');
                placeholder.className = 'chart-empty-state d-flex flex-column align-items-center justify-content-center h-100 text-muted';
                placeholder.innerHTML = `
                    <i class="fas fa-chart-simple mb-2" style="font-size: 2rem; opacity: 0.3;"></i>
                    <span class="small">No data to display yet</span>
                    <span class="x-small text-muted mt-1">Process scans or save student records to see charts</span>
                `;
                canvas.style.display = 'none';
                parent.appendChild(placeholder);
            });
            return;
        }

        // If there was a placeholder before, remove it and show canvas
        [scoreCtx, activityCtx].forEach(canvas => {
            if (!canvas) return;
            canvas.style.display = 'block';
            const parent = canvas.parentElement;
            const existing = parent.querySelector('.chart-empty-state');
            if (existing) existing.remove();
        });

        if (typeof Chart === 'undefined') return;

        // ---- Score Distribution Chart (bar chart: 0-49, 50-74, 75-89, 90-100) ----
        if (scoreCtx) {
            const buckets = [
                { label: '0-49%', min: 0, max: 49, color: 'rgba(220, 53, 69, 0.75)' },
                { label: '50-74%', min: 50, max: 74, color: 'rgba(255, 193, 7, 0.75)' },
                { label: '75-89%', min: 75, max: 89, color: 'rgba(13, 202, 240, 0.75)' },
                { label: '90-100%', min: 90, max: 100, color: 'rgba(25, 135, 84, 0.75)' },
            ];
            const data = buckets.map(b => dataSource.filter(s => {
                const pct = Number(s.percentage) || 0;
                return pct >= b.min && pct <= b.max;
            }).length);

            const chart = new Chart(scoreCtx, {
                type: 'bar',
                data: {
                    labels: buckets.map(b => b.label),
                    datasets: [{
                        label: 'Students',
                        data,
                        backgroundColor: buckets.map(b => b.color),
                        borderColor: buckets.map(b => b.color.replace('0.75', '1')),
                        borderWidth: 1,
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { stepSize: Math.max(1, Math.ceil(Math.max(...data) / 5)) }
                        }
                    },
                    plugins: { legend: { display: false } }
                }
            });
            this._dashboardCharts.push(chart);
        }

        // ---- Daily Scan Activity (line chart - last 7 days) ----
        if (activityCtx) {
            const days = [];
            const counts = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().slice(0, 10);
                days.push(d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
                const count = dataSource.filter(s => {
                    const ts = s.timestamp || s.created_at || s.createdAt;
                    return ts && String(ts).slice(0, 10) === dateStr;
                }).length;
                counts.push(count);
            }

            const chart = new Chart(activityCtx, {
                type: 'line',
                data: {
                    labels: days,
                    datasets: [{
                        label: 'Records',
                        data: counts,
                        fill: true,
                        tension: 0.4,
                        backgroundColor: 'rgba(13, 110, 253, 0.1)',
                        borderColor: 'rgba(13, 110, 253, 0.8)',
                        pointBackgroundColor: 'rgba(13, 110, 253, 1)',
                        pointRadius: 4,
                        pointHoverRadius: 6,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { stepSize: Math.max(1, Math.ceil(Math.max(...counts) / 5)) }
                        }
                    },
                    plugins: { legend: { display: false } }
                }
            });
            this._dashboardCharts.push(chart);
        }
    }
    fitAnswerSheetPage() {
        this.answerSheetPreviewMode = 'fit';
        this.applyAnswerSheetPreviewZoom();
    }

    fitAnswerSheetWidth() {
        this.answerSheetPreviewMode = 'width';
        this.applyAnswerSheetPreviewZoom();
    }

    zoomAnswerSheetIn() {
        this.answerSheetPreviewMode = 'custom';
        this.answerSheetPreviewZoom += 0.15;
        this.applyAnswerSheetPreviewZoom();
    }

    zoomAnswerSheetOut() {
        this.answerSheetPreviewMode = 'custom';
        this.answerSheetPreviewZoom = Math.max(0.1, this.answerSheetPreviewZoom - 0.15);
        this.applyAnswerSheetPreviewZoom();
    }

    applyAnswerSheetPreviewZoom() {
        const preview = document.getElementById('answerSheetPreview');
        const viewport = document.getElementById('answerSheetPreviewViewport');
        if (!preview || !viewport) return;

        // Reset transform to measure actual size
        preview.style.transform = 'none';
        
        // Use timeout to allow reflow so we can measure properly
        setTimeout(() => {
            const sheetRect = preview.getBoundingClientRect();
            const viewportRect = viewport.getBoundingClientRect();
            
            if (sheetRect.width === 0 || sheetRect.height === 0) return; // not rendered yet

            if (this.answerSheetPreviewMode === 'fit') {
                const padding = 48; // Account for canvas padding
                const scaleX = (viewportRect.width - padding) / sheetRect.width;
                const scaleY = (viewportRect.height - padding) / sheetRect.height;
                this.answerSheetPreviewZoom = Math.min(scaleX, scaleY, 1); // Max 100%
            } else if (this.answerSheetPreviewMode === 'width') {
                const padding = 48;
                this.answerSheetPreviewZoom = (viewportRect.width - padding) / sheetRect.width;
            }

            preview.style.transform = `scale(${this.answerSheetPreviewZoom})`;
        }, 10);
    }

    generateGenericSheet() {
        const select = document.getElementById('examQuizSelect');
        const qId = select.value;
        const q = this.quizzes.find(x => String(x.id) === String(qId));
        
        if (!q) {
            this.showToast('Please select an exam first', 'warning');
            return;
        }

        const format = q.format || 'multi-subject';
        const paperSize = 'a4';

        // Generate proper examId (like EX5V1QFV)
        const examId = this.createBatchExamId();
        console.log(`[AnswerSheet] qr examId=${examId}`);

        const config = {
            ...this.normalizeQuizData(q),
            courseName: 'Answer Sheet',
            courseLogo: 'pcc.png',
            subjects: this.getSubjectConfigForQuiz(q),
            examId: examId,
            paperSize: paperSize,
            // Add minimal studentData to get QR code and proper examId
            studentData: {
                examId: examId,
                sheetId: '001',
                studentName: '',
                course: 'Answer Sheet',
                age: '',
                roomNo: '1',
                seatNo: '1',
                dateTime: this.formatLocalDateTimeForSheet()
            }
        };
        
        scanCheckConfig.currentQuiz = config;
        scanCheckConfig.currentFormat = format;
        localStorage.setItem('scancheck_current_quiz', JSON.stringify(config));
        localStorage.setItem('scancheck_sheet_format', format);

        if (format === 'normal' && window.normalAnswerSheetGenerator) {
            window.normalAnswerSheetGenerator.generate(config);
        } else if (window.answerSheetGenerator) {
            window.answerSheetGenerator.generate(config);
        }

        // Show success with layoutId once the layout is saved
        setTimeout(() => {
            const savedLayout = window.latestOmrGeneratedLayout;
            if (savedLayout && savedLayout.examId) {
                console.log(`[AnswerSheet] saved layout filename=${savedLayout.examId}.json`);
                this.showToast(`Answer sheet generated successfully. Layout saved as ${savedLayout.examId}.json. Use this newly generated sheet for scanning.`, 'success');
            } else {
                this.showToast(`Generated ${format === 'normal' ? 'Single-Subject' : 'Multi-Subject'} answer sheet`, 'success');
            }
        }, 500);

        this.applyAnswerSheetPreviewZoom();
        
        // Scroll to preview
        document.getElementById('answerSheetPreview').scrollIntoView({ behavior: 'smooth' });
    }

    showAuthenticatedUI() {
        document.getElementById('signInBtn').style.display = 'none';
        document.getElementById('signOutBtn').classList.remove('d-none');
        const addStaffBtn = document.getElementById('addStaffBtn');
        if (addStaffBtn) addStaffBtn.classList.remove('d-none');
    }

    cleanupBootstrapModalState() {
        document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.remove());
        document.body.classList.remove('modal-open');
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('padding-right');
    }

    showGuestUI() {
        document.getElementById('signInBtn').style.display = 'block';
        document.getElementById('signOutBtn').classList.add('d-none');
        const addStaffBtn = document.getElementById('addStaffBtn');
        if (addStaffBtn) addStaffBtn.classList.add('d-none');
        // Show login modal if not authenticated
        const authModalEl = document.getElementById('authModal');
        this.cleanupBootstrapModalState();
        const authModal = bootstrap.Modal.getOrCreateInstance(authModalEl);
        authModal.show();
    }

    handleUnauthorized() {
        localStorage.removeItem('scancheck_token');
        this.quizzes = [];
        this.scanResults = [];
        this.records = [];
        this.systems = [];
        this.renderQuizList();
        this.renderScanResults();
        this.renderRecords();
        this.renderSystems();
        this.showGuestUI();
    }

    setupAuthEventListeners() {
        document.getElementById('signInBtn').addEventListener('click', () => {
            const authModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('authModal'));
            authModal.show();
        });

        document.getElementById('authForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData.entries());
            
            try {
                const result = await scanCheckConfig.apiCall('/api/auth/login', {
                    method: 'POST',
                    body: JSON.stringify(data)
                });

                localStorage.setItem('scancheck_token', result.token);
                const modalEl = document.getElementById('authModal');
                const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
                if (modal) modal.hide();
                this.cleanupBootstrapModalState();
                setTimeout(() => this.cleanupBootstrapModalState(), 200);
                this.showAuthenticatedUI();
                await this.loadAllData();
                toastManager.showSuccess('Signed in successfully');
                
                // Retry pending action if any
                await this.retryPendingAction();
            } catch (error) {
                // Use ErrorHandler to format the error
                const formattedError = errorHandler.handleError(error, 'authentication');
                
                // Show specific error message
                if (error.message && error.message.toLowerCase().includes('invalid')) {
                    toastManager.showError('Invalid username or password. Please try again.');
                } else {
                    toastManager.showError(formattedError.message);
                }
            }
        });

        const togglePwBtn = document.getElementById('togglePasswordBtn');
        const pwInput = document.getElementById('authPassword');
        if (togglePwBtn) {
            togglePwBtn.addEventListener('click', () => {
                // Toggle password visibility
                pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
                // Toggle eye icon
                const icon = togglePwBtn.querySelector('i');
                if (icon) {
                    icon.classList.toggle('fa-eye');
                    icon.classList.toggle('fa-eye-slash');
                }
            });
        }
    }

    async checkServerConnection() {
        const statusElement = document.getElementById('dashboardServerStatus');
        const serverUrlInput = document.getElementById('serverUrl');
        
        // Show the effective URL even if stored as relative
        if (serverUrlInput) {
            serverUrlInput.value = scanCheckConfig.serverUrl || window.location.origin;
        }

        if (!statusElement) return;
        
        const result = await scanCheckConfig.testConnection();

        if (result.success) {
            statusElement.innerHTML = `
                <span class="badge status-connected">
                    <span class="status-dot"></span>
                    <span>Connected</span>
                </span>
            `;
        } else {
            statusElement.innerHTML = `
                <span class="badge status-disconnected">
                    <span class="status-dot"></span>
                    <span>Disconnected</span>
                </span>
            `;
        }
    }

    async loadQuizzes() {
        try {
            const quizzes = await this.apiCallWithAuth('/api/quizzes', {}, 'loadQuizzes');
            this.quizzes = (quizzes || []).map((quiz) => this.normalizeQuizData(quiz));
            this.renderQuizList();

            // Also load archived count
            try {
                const archived = await this.apiCallWithAuth('/api/quizzes?archived=1', {}, 'loadArchivedCount');
                const badge = document.getElementById('archivedCountBadge');
                if (badge) badge.textContent = Array.isArray(archived) ? archived.length : 0;
            } catch (e) { /* ignore */ }
        } catch (error) {
            console.error('Error loading quizzes:', error);
            this.quizzes = this.getLocalQuizzes().map((quiz) => this.normalizeQuizData(quiz));
            this.renderQuizList();
        }
    }

    async loadScanResults(search = '', quizFilter = '', entryFilter = '', residencyFilter = '', equityFilter = '', options = {}) {
        const { skipRenderIfUnchanged = false } = options;
        try {
            let url = '/api/scans';
            const params = [];
            if (quizFilter) params.push(`quizId=${quizFilter}`);
            if (entryFilter) params.push(`entryType=${entryFilter}`);
            if (residencyFilter) params.push(`residencyType=${residencyFilter}`);
            if (equityFilter) params.push(`equityGroup=${equityFilter}`);
            
            if (params.length > 0) {
                url += '?' + params.join('&');
            }
            
            const response = await this.apiCallWithAuth(url, {}, 'loadScanResults');
            let scanResults = Array.isArray(response?.scans) ? response.scans : [];
            // If scans came back empty, fall back to records mapping
            if (scanResults.length === 0) {
                try {
                    const records = await this.apiCallWithAuth('/api/records', {}, 'loadScanResultsFallback');
                    scanResults = Array.isArray(records) ? records.map(record => this.mapRecordToScanResult(record)) : [];
                } catch (fallbackError) {
                    console.warn('Scan Results fallback to records failed:', fallbackError);
                }
            } else {
                // Even when scans exist, enrich course/dept from records (records = source of truth)
                try {
                    const recs = Array.isArray(this.records) && this.records.length > 0
                        ? this.records
                        : await this.apiCallWithAuth('/api/records', {}, 'loadScanResultsEnrich');
                    if (Array.isArray(recs) && recs.length > 0) {
                        scanResults = scanResults.map(scan => {
                            const sName = String(scan?.student_name || scan?.studentName || '').toLowerCase().trim();
                            const qId = String(scan?.quiz_id || scan?.quizId || '');
                            if (sName && qId) {
                                const record = recs.find(r =>
                                    String(r.student_name || '').toLowerCase().trim() === sName &&
                                    String(r.quiz_id || r.quizId || '') === qId
                                );
                                if (record) {
                                    scan.course = record.course || scan.course || '';
                                    scan.department = record.course || scan.department || '';
                                }
                            }
                            return scan;
                        });
                    }
                } catch (enrichError) {
                    console.warn('Scan Results enrichment from records failed:', enrichError);
                }
            }
            const nextSignature = this.getScanResultsSignature(scanResults);
            const prevSignature = this._lastScanResultsSignature || '';
            this.scanResults = scanResults;
            this._lastScanResultsSignature = nextSignature;
            if (skipRenderIfUnchanged && prevSignature === nextSignature) {
                return;
            }
            this.renderScanResults(search, quizFilter, entryFilter, residencyFilter, equityFilter);
            this.renderDashboard(); // Update dashboard when new scans arrive
        } catch (error) {
            console.error('Error loading scan results:', error);
            this.scanResults = this.getLocalScanResults();
            this.renderScanResults();
        }
    }

    getScanResultsSignature(results = []) {
        if (!Array.isArray(results) || results.length === 0) return 'empty';
        return results
            .map((item) => {
                const id = item?.id ?? item?.record_id ?? '';
                const ts = item?.timestamp || '';
                const score = item?.score ?? '';
                const pct = item?.percentage ?? '';
                const tq = item?.total_questions ?? item?.totalQuestions ?? '';
                const st = item?.status ?? item?.overall_status ?? '';
                return `${id}|${ts}|${score}|${pct}|${tq}|${st}`;
            })
            .join('~');
    }

    mapRecordToScanResult(record) {
        let parsedAnswers = [];
        if (Array.isArray(record?.answers)) {
            parsedAnswers = record.answers;
        } else if (typeof record?.answers === 'string' && record.answers.trim()) {
            try {
                const decoded = JSON.parse(record.answers);
                parsedAnswers = Array.isArray(decoded) ? decoded : [];
            } catch (_) {
                parsedAnswers = [];
            }
        }

        const safeIdNum = Number(record?.id);
        const fallbackId = Number.isFinite(safeIdNum) ? -Math.abs(safeIdNum) : `record-${Date.now()}`;
        const entryType = record?.entry_type || record?.entryType || null;
        const equityGroup = record?.special_equity_group || record?.specialEquityGroup || null;
        const quizId = record?.quiz_id != null ? record.quiz_id : record?.quizId;
        const quizTitle = record?.quiz_title || record?.quizTitle || '';
        const totalQuestions = Number(record?.total_questions ?? record?.totalQuestions ?? parsedAnswers.length ?? 0) || 0;
        const percentage = Number.parseFloat(String(record?.percentage ?? 0)) || 0;
        
        // Get the quiz's passing score if available, default to 75
        let passingScore = 75;
        const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
        if (quiz && quiz.passingScore) {
            passingScore = quiz.passingScore;
        }
        
        const status = record?.status || (percentage >= passingScore ? 'PASS' : 'FAIL');

        return {
            id: fallbackId,
            record_id: record?.id,
            sheet_id: record?.sheet_id || record?.sheetId || '',
            student_id: record?.student_id || record?.studentId || '',
            student_name: record?.student_name || record?.studentName || 'Student',
            quiz_id: quizId,
            quiz_title: quizTitle,
            answers: parsedAnswers,
            score: Number(record?.score || 0),
            total_questions: totalQuestions,
            total_score: Number(record?.score || 0),
            percentage,
            // overall_percentage omitted – not used for ranking
            status,
            overall_status: status,
            course: record?.course || '',
            entry_type: entryType,
            special_equity_group: equityGroup,
            entryType,
            specialEquityGroup: equityGroup,
            timestamp: record?.timestamp || null,
            image_path: record?.image_path || null,
            photo: record?.image_path || null
        };
    }

    async loadRecords() {
        try {
            this.records = await this.apiCallWithAuth('/api/records', {}, 'loadRecords');
            this.populateRecordsFilters();
            this.renderRecords();
        } catch (error) {
            console.error('Error loading records:', error);
        }
    }

    async refreshRecordDependentViews() {
        await this.loadRecords();
        await this.loadScanResults(
            document.getElementById('scanSearch')?.value || '',
            document.getElementById('scanQuizFilter')?.value || '',
            document.getElementById('scanEntryFilter')?.value || '',
            document.getElementById('scanEquityFilter')?.value || ''
        );
        await this.refreshReports();
    }

    async clearRecords() {
        if (!confirm('Are you sure you want to clear all student records? This action cannot be undone.')) {
            return;
        }

        try {
            await this.apiCallWithAuth('/api/records', {
                method: 'DELETE'
            }, 'clearRecords');
            this.records = [];
            this.scanResults = [];
            this._lastScanResultsSignature = 'empty';
            this.renderRecords();
            this.renderScanResults(
                document.getElementById('scanSearch')?.value || '',
                document.getElementById('scanQuizFilter')?.value || '',
                document.getElementById('scanEntryFilter')?.value || '',
                document.getElementById('scanEquityFilter')?.value || ''
            );
            this.renderDashboard();
            toastManager.showSuccess('All student records cleared');
            await this.refreshReports();
            // Re-populate filters to reflect that data is gone
            this.populateRecordsFilters();
        } catch (error) {
            // Error handled by apiCallWithAuth
        }
    }

    async loadSystems() {
        try {
            this.systems = await this.apiCallWithAuth('/api/systems', {}, 'loadSystems');
            this.renderSystems();
            this.refreshSystemBackupHistory();
        } catch (error) {
            console.error('Error loading systems:', error);
        }
    }

    async clearSystems() {
        if (!confirm('Are you sure you want to clear all system data? This action cannot be undone.')) {
            return;
        }

        try {
            await this.apiCallWithAuth('/api/systems', {
                method: 'DELETE'
            }, 'clearSystems');
            this.systems = [];
            this.renderSystems();
            toastManager.showSuccess('All system data cleared successfully');
        } catch (error) {
            console.error('Error clearing systems:', error);
            // Error already handled by apiCallWithAuth
        }
    }

    setOmrRecalibrationLog(message, isError = false) {
        const log = document.getElementById('omrRecalibrationLog');
        if (!log) return;
        log.textContent = String(message || '').trim() || 'Ready.';
        log.classList.toggle('text-warning', isError);
    }

    async handleOmrRecalibrationImagePick(file) {
        if (!file) return;
        if (!String(file.type || '').startsWith('image/')) {
            this.showToast('Please select an image file.', 'warning');
            return;
        }
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Failed to read image file.'));
            reader.readAsDataURL(file);
        });
        this.omrRecalibrationImageData = base64;
        this.omrRecalibrationImageName = String(file.name || 'reference-image');
        const hint = document.getElementById('omrRecalibrationDropHint');
        if (hint) hint.textContent = `Selected: ${this.omrRecalibrationImageName}`;
        this.setOmrRecalibrationLog(`Ready: uploaded image "${this.omrRecalibrationImageName}"`);
    }

    buildOmrRecalibrationPayload() {
        const imagePath = String(document.getElementById('omrRecalibrationImagePath')?.value || '').trim();
        if (imagePath) {
            localStorage.setItem('scancheck_omr_recalibration_image_path', imagePath);
        }
        if (this.omrRecalibrationImageData) {
            return {
                imageData: this.omrRecalibrationImageData,
                fileName: this.omrRecalibrationImageName || 'reference-image'
            };
        }
        if (imagePath) {
            return { imagePath };
        }
        return {};
    }

    async setOmrRecalibrationReference() {
        try {
            const payload = this.buildOmrRecalibrationPayload();
            if (!payload.imagePath && !payload.imageData) {
                this.showToast('Set an image path or drop an image first.', 'warning');
                return;
            }
            this.setOmrRecalibrationLog('Setting calibration reference...');
            const response = await this.apiCallWithAuth('/api/omr/recalibration/reference', {
                method: 'POST',
                body: JSON.stringify(payload)
            }, 'setOmrRecalibrationReference');

            const text = [
                'Reference image updated.',
                `Source: ${response.sourcePath || '-'}`,
                `Target: ${response.destinationPath || '-'}`,
                `Size: ${response.bytes || 0} bytes`
            ].join('\n');
            this.setOmrRecalibrationLog(text);
            this.showToast('Calibration reference image updated.', 'success');
        } catch (error) {
            this.setOmrRecalibrationLog(`Failed to set reference image.\n${error.message || error}`, true);
        }
    }

    async runOmrRecalibration() {
        try {
            const payload = this.buildOmrRecalibrationPayload();
            this.setOmrRecalibrationLog('Starting OMR recalibration...');
            const response = await this.apiCallWithAuth('/api/omr/recalibration/run', {
                method: 'POST',
                body: JSON.stringify(payload)
            }, 'runOmrRecalibration');

            const text = [
                response.message || 'Recalibration started.',
                `PID: ${response.pid || '-'}`,
                `Input dir: ${response.calibrationInputDir || '-'}`,
                `Reference image: ${response.referenceImagePath || '-'}`,
                `Command: ${response.command || '-'}`
            ].join('\n');
            this.setOmrRecalibrationLog(text);
            this.showToast('OMR recalibration started.', 'success');
        } catch (error) {
            this.setOmrRecalibrationLog(`Failed to start recalibration.\n${error.message || error}`, true);
        }
    }

    getOmrEditorCommand() {
        const input = document.getElementById('omrEditorCommand');
        const command = String(input?.value || '').trim() || 'code';
        localStorage.setItem('scancheck_omr_editor_command', command);
        return command;
    }

    async openOmrConfigInEditor(target) {
        try {
            const editorCommand = this.getOmrEditorCommand();
            this.setOmrRecalibrationLog(`Opening ${target}...`);
            const response = await this.apiCallWithAuth('/api/omr/recalibration/open-config', {
                method: 'POST',
                body: JSON.stringify({ target, editorCommand })
            }, 'openOmrConfigInEditor');

            const text = [
                response.message || 'Opened file.',
                `File: ${response.filePath || '-'}`,
                `Command: ${response.command || '-'}`
            ].join('\n');
            this.setOmrRecalibrationLog(text);
            this.showToast('Opened config file in editor.', 'success');
        } catch (error) {
            this.setOmrRecalibrationLog(`Failed to open file in editor.\n${error.message || error}`, true);
        }
    }

    openScannerFilePicker() {
        const input = document.getElementById('scannerImageInput');
        if (input) {
            input.removeAttribute('capture');
            input.value = '';
            input.click();
        }
    }

    setupEventListeners() {
        document.getElementById('scannerExamSelect')?.addEventListener('change', (e) => {
            const quizId = e.target.value;
            localStorage.setItem('scancheck_selected_scanner_quiz', quizId || '');
            if (this.detectedScannerLayout && String(this.detectedScannerLayout.quizId || '') !== String(quizId || '')) {
                this.detectedScannerLayout = null;
                this.renderScannerLayoutDetection(null, 'idle');
            }
            this.updateScannerScanButtonState();
        });

        // Search & Filter
        document.getElementById('quizSearch')?.addEventListener('input', (e) => {
            this.renderQuizList(e.target.value);
        });

        document.getElementById('scanSearch')?.addEventListener('input', (e) => {
            this.renderScanResults(
                e.target.value, 
                document.getElementById('scanQuizFilter')?.value,
                document.getElementById('scanEntryFilter')?.value,
                document.getElementById('scanResidencyFilter')?.value,
                document.getElementById('scanEquityFilter')?.value
            );
        });

        document.getElementById('scanQuizFilter')?.addEventListener('change', (e) => {
            this.loadScanResults(
                document.getElementById('scanSearch')?.value, 
                e.target.value,
                document.getElementById('scanEntryFilter')?.value,
                document.getElementById('scanResidencyFilter')?.value,
                document.getElementById('scanEquityFilter')?.value
            );
        });

        document.getElementById('scanEntryFilter')?.addEventListener('change', (e) => {
            this.loadScanResults(
                document.getElementById('scanSearch')?.value,
                document.getElementById('scanQuizFilter')?.value,
                e.target.value,
                document.getElementById('scanResidencyFilter')?.value,
                document.getElementById('scanEquityFilter')?.value
            );
        });

        document.getElementById('scanResidencyFilter')?.addEventListener('change', (e) => {
            this.loadScanResults(
                document.getElementById('scanSearch')?.value,
                document.getElementById('scanQuizFilter')?.value,
                document.getElementById('scanEntryFilter')?.value,
                e.target.value,
                document.getElementById('scanEquityFilter')?.value
            );
        });

        document.getElementById('scanEquityFilter')?.addEventListener('change', (e) => {
            this.loadScanResults(
                document.getElementById('scanSearch')?.value,
                document.getElementById('scanQuizFilter')?.value,
                document.getElementById('scanEntryFilter')?.value,
                document.getElementById('scanResidencyFilter')?.value,
                e.target.value
            );
        });

        document.getElementById('recordsSearch')?.addEventListener('input', () => {
            this.renderRecords();
        });

        document.getElementById('recordsStatusFilter')?.addEventListener('change', () => {
            this.renderRecords();
        });

        document.getElementById('recordsQuizFilter')?.addEventListener('change', () => {
            this.renderRecords();
        });

        document.getElementById('recordsEntryFilter')?.addEventListener('change', () => {
            this.renderRecords();
        });

        document.getElementById('recordsResidencyFilter')?.addEventListener('change', () => {
            this.renderRecords();
        });

        document.getElementById('recordsEquityFilter')?.addEventListener('change', () => {
            this.renderRecords();
        });

        // Report filters trigger a refresh when changed
        ['reportQuizFilter', 'reportDateFrom', 'reportDateTo', 'reportEntryFilter', 'reportEquityFilter', 'reportRankingSort', 'reportSubjectSelect', 'reportMinScore'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => {
                this.refreshReports();
            });
        });

        document.getElementById('qrExcelImportBtn')?.addEventListener('click', () => {
            this.openStudentExcelImport();
        });
        document.getElementById('qrExcelImportInput')?.addEventListener('change', async (event) => {
            const [file] = event.target.files || [];
            await this.handleStudentExcelImport(file);
            event.target.value = '';
        });
        document.getElementById('qrExcelStudentSearch')?.addEventListener('input', (event) => {
            this.filterImportedStudents(event.target.value);
        });
        document.getElementById('qrPreviewPrevStudent')?.addEventListener('click', () => {
            this.navigateImportedStudent(-1);
        });
        document.getElementById('qrPreviewNextStudent')?.addEventListener('click', () => {
            this.navigateImportedStudent(1);
        });

        // Quiz creation form
        document.getElementById('createQuizForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleQuizFormSubmit();
        });
        this.applyQuizFormFormatRules();

        // Cancel update button
        document.getElementById('cancelUpdateBtn').addEventListener('click', () => {
            this.resetQuizForm();
        });

        // Navigation links
        document.getElementById('navDashboard')?.addEventListener('click', (e) => {
            e.preventDefault();
            location.hash = '#/dashboard';
        });
        document.getElementById('navExam')?.addEventListener('click', (e) => {
            e.preventDefault();
            location.hash = '#/exam';
        });
        document.getElementById('navQuizzes')?.addEventListener('click', (e) => {
            e.preventDefault();
            location.hash = '#/quizzes';
        });
        document.getElementById('navAnswerKey')?.addEventListener('click', (e) => {
            e.preventDefault();
            location.hash = '#/answer-key';
        });
        document.getElementById('sidebarToggleBtn')?.addEventListener('click', () => {
            this.toggleSidebarDrawer();
        });
        document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
            this.closeSidebarDrawer();
        });
        window.addEventListener('resize', () => {
            if (window.innerWidth >= 992) this.closeSidebarDrawer();
        });
        const setActiveNav = (id) => {
            ['navDashboard','navExam','navQuizzes','navAnswerKey','navScan','navRecords','navReports','navSystems','navReceivedPapers','navConnectedDevices','navScanResults'].forEach(nid => {
                const el = document.getElementById(nid);
                if (!el) return;
                if (nid === id) {
                    el.classList.add('active');
                    el.setAttribute('aria-current', 'page');
                } else {
                    el.classList.remove('active');
                    el.removeAttribute('aria-current');
                }
            });
            this.syncTopbarContext();
        };

        const showPage = async (page) => {
            const pages = ['pageDashboard','pageScanResults','pageRecords','pageReports','pageSystems','pageExam','pageQuizzes','pageAnswerKey','pageScan','pageReceivedPapers','pageConnectedDevices'];
            pages.forEach(pid => {
                const el = document.getElementById(pid);
                if (!el) return;
                const showing = pid === page;
                el.classList.toggle('d-none', !showing);
                if (showing) {
                    el.classList.remove('animate-fade-up');
                    void el.offsetWidth;
                    el.classList.add('animate-fade-up');
                } else {
                    el.classList.remove('animate-fade-up');
                }
            });
            
            // render content when switching
            if (page === 'pageDashboard') {
                this.renderDashboard();
                this.loadSystemInfo();
            }
            if (page === 'pageScanResults') this.renderScanResults();
            if (page === 'pageRecords') {
                this.populateRecordsFilters();
                this.renderRecords();
            }
            if (page === 'pageReports') {
                await this.refreshReports();
            }
            if (page === 'pageSystems') this.renderSystems();
            if (page === 'pageExam') {
                this.populateExamPage();
                this.populateBarcodePage();
            }
            if (page === 'pageQuizzes') this.renderQuizList();
            if (page === 'pageAnswerKey') this.populateAnswerKeyPage();
            if (page === 'pageReceivedPapers') this.loadReceivedPapers();
            if (page === 'pageConnectedDevices') this.renderConnectedDevices();
        };

        const navigate = (route) => {
            switch (route) {
                case '#/dashboard':
                    showPage('pageDashboard');
                    setActiveNav('navDashboard');
                    break;
                case '#/quizzes':
                    showPage('pageQuizzes');
                    setActiveNav('navQuizzes');
                    break;
                case '#/answer-key':
                    showPage('pageAnswerKey');
                    setActiveNav('navAnswerKey');
                    break;
                case '#/barcode':
                    // Legacy URL: barcode page is merged into Exam Mode.
                    showPage('pageExam');
                    setActiveNav('navExam');
                    break;
                case '#/scan':
                    showPage('pageScan');
                    setActiveNav('navScan');
                    this.populateScanExamSelect();
                    this.renderBulkScanQueue();
                    break;
                case '#/records':
                    showPage('pageRecords');
                    setActiveNav('navRecords');
                    break;
                case '#/reports':
                    showPage('pageReports');
                    setActiveNav('navReports');
                    break;
                case '#/systems':
                    showPage('pageSystems');
                    setActiveNav('navSystems');
                    break;
                case '#/exam':
                    showPage('pageExam');
                    setActiveNav('navExam');
                    break;
                case '#/received-papers':
                    showPage('pageReceivedPapers');
                    setActiveNav('navReceivedPapers');
                    break;
                case '#/scan-results':
                    showPage('pageScanResults');
                    setActiveNav('navScanResults');
                    break;
                case '#/connected-devices':
                    showPage('pageConnectedDevices');
                    setActiveNav('navConnectedDevices');
                    break;
                default:
                    if (this.isAuthenticated()) {
                        showPage('pageDashboard');
                        setActiveNav('navDashboard');
                    } else {
                        showPage('pageExam');
                        setActiveNav('navExam');
                    }
            }
            this.closeSidebarDrawer();
        };

        window.addEventListener('beforeunload', (event) => {
            if (!this.answerKeyDirty || !this.isAnswerKeyFormVisible()) return;
            event.preventDefault();
            event.returnValue = '';
        });

        window.addEventListener('hashchange', () => {
            if (this.answerKeyHashGuardBypass) return;
            const nextHash = location.hash || (this.isAuthenticated() ? '#/dashboard' : '#/exam');
            if (this.shouldBlockAnswerKeyNavigation(nextHash)) {
                const leave = confirm('You have unsaved Answer Key changes. Leave without saving?');
                if (!leave) {
                    this.answerKeyHashGuardBypass = true;
                    location.hash = this.currentRouteHash || '#/answer-key';
                    setTimeout(() => {
                        this.answerKeyHashGuardBypass = false;
                    }, 0);
                    return;
                }
                this.setAnswerKeyDirty(false);
            }
            navigate(nextHash);
            this.currentRouteHash = nextHash;
        });
        const initialRoute = location.hash || (this.isAuthenticated() ? '#/dashboard' : '#/exam');
        navigate(initialRoute);
        this.currentRouteHash = initialRoute;

        ['navDashboard','navExam','navQuizzes','navAnswerKey','navScan','navRecords','navReports','navSystems','navReceivedPapers','navConnectedDevices','navScanResults'].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', () => {
                this.closeSidebarDrawer();
            });
        });

        // Sign out button
        document.getElementById('signOutBtn').addEventListener('click', () => {
            this.signOut();
        });

        // Test server button
        const testBtn = document.getElementById('testServerBtn');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                const result = await scanCheckConfig.testConnection();
                this.showToast(result.success ? 'Server reachable' : `Server error: ${result.message}`, result.success ? 'success' : 'danger');
                this.checkServerConnection();
            });
        }

        const saveServerUrlBtn = document.getElementById('saveServerUrlBtn');
        if (saveServerUrlBtn) {
            saveServerUrlBtn.addEventListener('click', () => {
                saveServerUrlBtn.classList.remove('btn-outline-primary');
                saveServerUrlBtn.classList.add('btn-success');
                saveServerUrlBtn.innerHTML = '<i class="fas fa-check"></i>';

                setTimeout(() => {
                    saveServerUrlBtn.classList.remove('btn-success');
                    saveServerUrlBtn.classList.add('btn-outline-primary');
                    saveServerUrlBtn.innerHTML = '<i class="fas fa-save"></i>';
                }, 1500);
            });
        }

        const developerPanelsToggle = document.getElementById('settingShowDeveloperTestingPanels');
        if (developerPanelsToggle) {
            developerPanelsToggle.addEventListener('change', (e) => {
                localStorage.setItem('scancheck_show_developer_testing_panels', e.target.checked ? '1' : '0');
                this.applyScannerViewSettings();
            });
        }

        const rawDataToggle = document.getElementById('settingShowRawScanData');
        if (rawDataToggle) {
            rawDataToggle.addEventListener('change', (e) => {
                localStorage.setItem('scancheck_show_raw_scan_data', e.target.checked ? '1' : '0');
                this.applyScannerViewSettings();
            });
        }

        const debugViewToggle = document.getElementById('settingShowOmrDebugView');
        if (debugViewToggle) {
            debugViewToggle.addEventListener('change', (e) => {
                localStorage.setItem('scancheck_show_omr_debug_view', e.target.checked ? '1' : '0');
                this.applyScannerViewSettings();
            });
        }

        const recalibrationPathInput = document.getElementById('omrRecalibrationImagePath');
        if (recalibrationPathInput) {
            recalibrationPathInput.addEventListener('change', (e) => {
                const value = String(e.target.value || '').trim();
                localStorage.setItem('scancheck_omr_recalibration_image_path', value);
                if (value) {
                    this.omrRecalibrationImageData = '';
                    this.omrRecalibrationImageName = '';
                    const hint = document.getElementById('omrRecalibrationDropHint');
                    if (hint) hint.textContent = 'No uploaded file selected';
                }
            });
        }

        const editorCommandInput = document.getElementById('omrEditorCommand');
        if (editorCommandInput) {
            editorCommandInput.addEventListener('change', (e) => {
                localStorage.setItem('scancheck_omr_editor_command', String(e.target.value || '').trim() || 'code');
            });
        }

        const recalibrationFileInput = document.getElementById('omrRecalibrationFileInput');
        if (recalibrationFileInput) {
            recalibrationFileInput.addEventListener('change', async (event) => {
                const [file] = event.target.files || [];
                try {
                    await this.handleOmrRecalibrationImagePick(file);
                } catch (error) {
                    this.setOmrRecalibrationLog(`Failed to load image file.\n${error.message || error}`, true);
                    this.showToast('Could not load dropped image.', 'danger');
                }
            });
        }

        const recalibrationDropZone = document.getElementById('omrRecalibrationDropZone');
        if (recalibrationDropZone) {
            recalibrationDropZone.addEventListener('click', () => {
                recalibrationFileInput?.click();
            });
            recalibrationDropZone.addEventListener('dragover', (event) => {
                event.preventDefault();
                recalibrationDropZone.classList.add('border-primary');
            });
            recalibrationDropZone.addEventListener('dragleave', () => {
                recalibrationDropZone.classList.remove('border-primary');
            });
            recalibrationDropZone.addEventListener('drop', async (event) => {
                event.preventDefault();
                recalibrationDropZone.classList.remove('border-primary');
                const [file] = event.dataTransfer?.files || [];
                try {
                    await this.handleOmrRecalibrationImagePick(file);
                } catch (error) {
                    this.setOmrRecalibrationLog(`Failed to load dropped image.\n${error.message || error}`, true);
                    this.showToast('Could not load dropped image.', 'danger');
                }
            });
        }

        document.getElementById('omrSetRecalibrationReferenceBtn')?.addEventListener('click', () => {
            this.setOmrRecalibrationReference();
        });

        document.getElementById('omrRunRecalibrationBtn')?.addEventListener('click', () => {
            this.runOmrRecalibration();
        });

        document.getElementById('omrOpenCalibrationTemplateBtn')?.addEventListener('click', () => {
            this.openOmrConfigInEditor('runtime-template');
        });

        document.getElementById('systemBackupDownloadBtn')?.addEventListener('click', () => {
            this.downloadSystemBackup();
        });
        document.getElementById('systemBackupChooseFileBtn')?.addEventListener('click', () => {
            document.getElementById('systemBackupFileInput')?.click();
        });
        document.getElementById('systemBackupFileInput')?.addEventListener('change', (event) => {
            const [file] = event.target.files || [];
            this.selectSystemBackupFile(file);
        });
        document.getElementById('systemBackupRestoreBtn')?.addEventListener('click', () => {
            this.restoreSystemBackup();
        });
        document.getElementById('aiOmrSaveSettingsBtn')?.addEventListener('click', () => {
            this.saveAiOmrSettings(false);
        });
        document.getElementById('aiOmrStrategy')?.addEventListener('change', (event) => {
            if (event.target.value === 'custom') {
                const advanced = document.getElementById('aiOmrAdvancedCollapse');
                if (advanced && window.bootstrap) {
                    bootstrap.Collapse.getOrCreateInstance(advanced, { toggle: false }).show();
                }
            }
        });
        document.getElementById('aiOmrProvider')?.addEventListener('change', () => {
            this.updateAiOmrProviderFields();
        });
        document.getElementById('aiOmrTestConnectionBtn')?.addEventListener('click', () => {
            this.testAiOmrConnection();
        });
        document.getElementById('aiOmrReplaceKeyBtn')?.addEventListener('click', () => {
            this.toggleAiKeyReplace(true);
        });
        document.getElementById('aiOmrCancelReplaceKeyBtn')?.addEventListener('click', () => {
            this.toggleAiKeyReplace(false);
        });
        document.getElementById('aiOmrRemoveKeyBtn')?.addEventListener('click', () => {
            if (confirm('Remove Gemini API key? AI scanning will stop working until another key is configured.')) {
                this.saveAiOmrSettings(true);
            }
        });
        document.getElementById('aiOmrRestorePromptBtn')?.addEventListener('click', () => {
            this.restoreDefaultAiPrompt();
        });
        document.getElementById('aiOmrToggleKeyBtn')?.addEventListener('click', () => {
            const input = document.getElementById('aiOmrApiKey');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        const editSubjectsModalEl = document.getElementById('editSubjectsModal');
        if (editSubjectsModalEl) {
            editSubjectsModalEl.addEventListener('show.bs.modal', () => {
                this.prepareEditSubjectsModal();
            });
        }

        // Received Papers sorting
        document.getElementById('courseSort')?.addEventListener('change', (e) => {
            this.renderReceivedPapers(e.target.value);
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (this.handleAnswerKeyKeyboardShortcut(e)) {
                return;
            }
            const isMac = navigator.platform.toUpperCase().indexOf('MAC')>=0;
            const key = (e.key || '').toLowerCase();
            if ((!isMac && e.ctrlKey && key==='p') || (isMac && e.metaKey && key==='p')) {
                e.preventDefault();
                printAnswerSheet();
            }
            if (key==='g') {
                generateAnswerSheet();
            }
        });
    }

    populateExamPage() {
        const select = document.getElementById('examQuizSelect');
        const scannerSelect = document.getElementById('scannerExamSelect');
        
        if (select) {
            const previous = select.value;
            select.innerHTML = this.quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)} (${q.questionCount}q)</option>`).join('');
            if (scanCheckConfig.currentQuiz && this.quizzes.some(q => String(q.id) === String(scanCheckConfig.currentQuiz.id))) {
                select.value = String(scanCheckConfig.currentQuiz.id);
            } else if (previous && this.quizzes.some(q => String(q.id) === previous)) {
                select.value = previous;
            }
        }

        if (scannerSelect) {
            const previous = scannerSelect.value;
            scannerSelect.innerHTML = '<option value="">Select Exam...</option>' + 
                this.quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)}</option>`).join('');
            if (previous && this.quizzes.some(q => String(q.id) === previous)) {
                scannerSelect.value = previous;
            }
        }
        
        const editSubjectsContainer = document.getElementById('editSubjectsContainer');
        if (editSubjectsContainer) {
            editSubjectsContainer.style.display = 'block';
        }
        if (select) {
            select.onchange = () => this.syncExamSelectionToPreview(true);
        }
        this.syncExamSelectionToPreview(false);
    }

    async populateAnswerKeyPage() {
        if (!this.isAnswerKeyFormVisible()) {
            this.setAnswerKeyDirty(false);
            this.answerKeyQuizId = null;
        }

        const select = document.getElementById('answerKeyQuizSelect');
        if (select) {
            const currentVal = select.value || '';
            select.innerHTML = '<option value="">-- Choose a quiz to set answers --</option>' + 
                this.quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)} (${q.questionCount}q)</option>`).join('');
            if (currentVal) select.value = currentVal;
        }

        await this.refreshAnswerKeyCatalog();

        const hasSelected = this.selectedAnswerKeyQuizId && this.answerKeyCatalog.some((item) => String(item.quizId) === String(this.selectedAnswerKeyQuizId));

        if (hasSelected) {
            await this.showAnswerKeyPreview(this.selectedAnswerKeyQuizId);
        } else {
            // DO NOT auto-select anymore. Show empty state until user clicks.
            this.selectedAnswerKeyQuizId = null;
            document.getElementById('akEmptyState')?.classList.remove('d-none');
            document.getElementById('answerKeyPreview')?.classList.add('d-none');
            document.getElementById('answerKeyEdit')?.classList.add('d-none');
        }

        // Render list last so the active state (highlight) is correct
        this.renderAnswerKeyList();
    }

    handleAnswerKeyQuizSelect(quizId, openForm = false) {
        const nextQuizId = String(quizId || '');
        if (openForm && this.answerKeyDirty && this.isAnswerKeyFormVisible() && nextQuizId && nextQuizId !== String(this.answerKeyQuizId || '')) {
            const proceed = confirm('You have unsaved Answer Key changes. Switch exam anyway?');
            if (!proceed) {
                const selectEl = document.getElementById('answerKeyQuizSelect');
                if (selectEl) selectEl.value = String(this.answerKeyQuizId || '');
                return;
            }
            this.setAnswerKeyDirty(false);
        }

        if (!nextQuizId) {
            document.getElementById('answerKeyEdit')?.classList.add('d-none');
            document.getElementById('akEmptyState')?.classList.remove('d-none');
            document.getElementById('answerKeyPreview')?.classList.add('d-none');
            this.setAnswerKeyDirty(false);
            this.answerKeyQuizId = null;
            return;
        }

        const select = document.getElementById('answerKeyQuizSelect');
        if (select) select.value = nextQuizId;

        if (!openForm) {
            return;
        }
        const quiz = this.quizzes.find(q => String(q.id) === nextQuizId);
        if (quiz) {
            this.showAnswerKeyForm(quiz);
        }
    }

    async refreshAnswerKeyCatalog() {
        const quizzes = Array.isArray(this.quizzes) ? this.quizzes : [];
        const rows = await Promise.all(quizzes.map(async (quiz) => {
            const answers = await this.loadAnswerKey(quiz.id);
            const plan = this.buildAnswerKeySubjectPlan(quiz.questionCount, this.getSubjectConfigForQuiz(quiz), quiz.format);
            const activeTotal = Number(plan.totalQuestions || quiz.questionCount || 0);
            const answered = Array.isArray(answers)
                ? answers.slice(0, activeTotal).filter((entry) => Boolean(String(entry || '').trim())).length
                : 0;
            return {
                quizId: String(quiz.id),
                title: quiz.title || `Quiz ${quiz.id}`,
                questionCount: activeTotal,
                answeredCount: answered,
                hasKey: answered > 0
            };
        }));

        this.answerKeyCatalog = rows
            .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    }

    renderAnswerKeyList() {
        const container = document.getElementById('answerKeyList');
        if (!container) return;

        const query = String(this.answerKeyListFilter || '').trim().toLowerCase();
        const rows = this.answerKeyCatalog.filter((item) => {
            if (!query) return true;
            return String(item.title || '').toLowerCase().includes(query);
        });

        if (rows.length === 0) {
            container.innerHTML = `<div class="text-muted small py-4 text-center">
                <i class="fas fa-search d-block mb-2 opacity-25" style="font-size: 24px;"></i>
                ${query ? 'No matches found.' : 'No saved keys yet.'}
            </div>`;
            return;
        }

        container.innerHTML = rows.map((item) => {
            const isActive = String(item.quizId) === String(this.selectedAnswerKeyQuizId || '');
            const pct = item.questionCount > 0 ? Math.round((item.answeredCount / item.questionCount) * 100) : 0;
            return `
                <button class="list-group-item list-group-item-action border-0 mb-1 rounded-3 ${isActive ? 'active shadow-sm' : ''}" 
                        onclick="app.selectAnswerKeyFromList('${escapeHtml(item.quizId)}')">
                    <div class="d-flex justify-content-between align-items-center">
                        <div class="text-truncate me-2">
                            <div class="fw-bold small text-truncate">${escapeHtml(item.title)}</div>
                            <div class="x-small opacity-75">${item.questionCount} Questions</div>
                        </div>
                        <div class="text-end">
                            <div class="x-small fw-bold">${pct}%</div>
                            <div class="progress mt-1" style="height: 3px; width: 40px;">
                                <div class="progress-bar bg-${pct === 100 ? 'success' : 'primary'}" style="width: ${pct}%"></div>
                            </div>
                        </div>
                    </div>
                </button>
            `;
        }).join('');
    }

    openCreateAnswerKey(preselectedQuizId = '') {
        // Reset and show the right panel parts for creation
        document.getElementById('akEmptyState')?.classList.add('d-none');
        document.getElementById('answerKeyPreview')?.classList.add('d-none');
        document.getElementById('answerKeyEdit')?.classList.add('d-none');
        
        const quizId = preselectedQuizId || this.selectedAnswerKeyQuizId;

        if (quizId) {
            this.handleAnswerKeyQuizSelect(quizId, true);
        } else {
            if (this.quizzes.length > 0) {
                this.showToast('Select an exam from the list on the left to set its answer key.', 'info');
            } else {
                this.showToast('No exams found. Please create an exam in the Library first.', 'warning');
                location.hash = '#/quizzes';
            }
            document.getElementById('akEmptyState')?.classList.remove('d-none');
        }
    }

    async selectAnswerKeyFromList(quizId) {
        const targetQuizId = String(quizId || '');
        if (!targetQuizId) return;
        if (this.answerKeyDirty && this.isAnswerKeyFormVisible() && targetQuizId !== String(this.answerKeyQuizId || '')) {
            const proceed = confirm('You have unsaved Answer Key changes. Leave editor and open another key?');
            if (!proceed) return;
            this.setAnswerKeyDirty(false);
        }
        await this.showAnswerKeyPreview(targetQuizId);
        this.renderAnswerKeyList();
    }

    async showAnswerKeyPreview(quizId) {
        const targetQuizId = String(quizId || '');
        const quiz = this.quizzes.find((item) => String(item.id) === targetQuizId);
        if (!quiz) return;

        const answers = await this.loadAnswerKey(quiz.id);
        const answerPlan = this.buildAnswerKeySubjectPlan(quiz.questionCount, this.getSubjectConfigForQuiz(quiz), quiz.format);
        const activeTotal = Number(answerPlan.totalQuestions || quiz.questionCount || 0);
        const answeredCount = Array.isArray(answers)
            ? answers.slice(0, activeTotal).filter((entry) => Boolean(String(entry || '').trim())).length
            : 0;

        this.selectedAnswerKeyQuizId = targetQuizId;
        scanCheckConfig.currentQuiz = quiz;

        const titleEl = document.getElementById('akPreviewTitle');
        const metaEl = document.getElementById('akPreviewMeta');
        const cardsEl = document.getElementById('akSummaryCards');
        
        if (!titleEl || !metaEl || !cardsEl) return;

        titleEl.textContent = quiz.title || `Exam ${quiz.id}`;
        metaEl.textContent = `${activeTotal} questions • ${answeredCount} answered • ${Math.max(activeTotal - answeredCount, 0)} blank`;

        cardsEl.innerHTML = answerPlan.sections.map((section) => {
            const sectionAnswers = Array.isArray(answers) ? answers.slice(section.startIndex - 1, section.startIndex - 1 + section.count) : [];
            const secAnsweredCount = sectionAnswers.filter(a => a).length;
            const secCompletion = section.count > 0 ? Math.round((secAnsweredCount / section.count) * 100) : 0;
            
            const previewAnswers = sectionAnswers.slice(0, 5).map((a, i) => `${i+1}:${a || '-'}`).join(', ');
            const previewText = previewAnswers + (section.count > 5 ? ' ...' : '');

            return `
                <div class="col-md-6">
                    <div class="card border shadow-none bg-light bg-opacity-50 h-100 cursor-pointer hover-shadow" 
                         onclick="app.openSelectedAnswerKeyEditor(); setTimeout(() => app.switchAnswerKeySubjectTab('${escapeHtml(section.code)}'), 50)">
                        <div class="card-body p-3">
                            <div class="d-flex justify-content-between align-items-center mb-2">
                                <h6 class="fw-bold mb-0 text-dark small text-uppercase">${escapeHtml(section.name)}</h6>
                                <span class="badge rounded-pill bg-${secAnsweredCount === section.count ? 'success' : 'warning'} bg-opacity-10 text-${secAnsweredCount === section.count ? 'success' : 'warning'} border border-${secAnsweredCount === section.count ? 'success' : 'warning'} border-opacity-25 x-small">
                                    ${secAnsweredCount}/${section.count}
                                </span>
                            </div>
                            <div class="d-flex justify-content-between align-items-center">
                                <small class="text-muted x-small">${previewText}</small>
                                <small class="fw-bold text-dark x-small">${secCompletion}%</small>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        document.getElementById('akEmptyState')?.classList.add('d-none');
        document.getElementById('answerKeyEdit')?.classList.add('d-none');
        document.getElementById('answerKeyPreview')?.classList.remove('d-none');
    }

    openSelectedAnswerKeyEditor() {
        const quizId = String(this.selectedAnswerKeyQuizId || '');
        if (!quizId) {
            this.showToast('Select an answer key first.', 'warning');
            return;
        }
        this.handleAnswerKeyQuizSelect(quizId, true);
    }

    promptDeleteSelectedAnswerKey() {
        const quizId = String(this.selectedAnswerKeyQuizId || '');
        if (!quizId) {
            this.showToast('Select an answer key first.', 'warning');
            return;
        }
        const quiz = this.quizzes.find((item) => String(item.id) === quizId);
        if (!quiz) return;
        scanCheckConfig.currentQuiz = quiz;
        this.handleAnswerKeyDelete();
    }

    populateScanExamSelect() {
        const scannerSelect = document.getElementById('scannerExamSelect');
        if (!scannerSelect) return;

        // Load quizzes into select
        scannerSelect.innerHTML = '<option value="">-- Select Exam --</option>' + 
            this.quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)} (${q.questionCount || q.question_count || 100}q)</option>`).join('');
        
        // Try to pre-select from localStorage
        const savedQuizId = localStorage.getItem('scancheck_selected_scanner_quiz');
        if (savedQuizId && this.quizzes.some(q => String(q.id) === String(savedQuizId))) {
            scannerSelect.value = String(savedQuizId);
        }
        this.updateScannerScanButtonState();
    }

    signOut() {
        if (confirm('Are you sure you want to sign out?')) {
            localStorage.removeItem('scancheck_token');
            this.quizzes = [];
            this.scanResults = [];
            this.records = [];
            this.systems = [];
            this.renderQuizList();
            this.renderScanResults();
            this.renderRecords();
            this.renderSystems();
            this.showGuestUI();
            this.showToast('Signed out successfully', 'success');
        }
    }

    toggleSidebarDrawer(forceState = null) {
        const shell = document.getElementById('appShell');
        if (!shell) return;
        const currentlyOpen = shell.classList.contains('sidebar-open');
        const nextOpen = forceState === null ? !currentlyOpen : Boolean(forceState);
        shell.classList.toggle('sidebar-open', nextOpen);
    }

    closeSidebarDrawer() {
        this.toggleSidebarDrawer(false);
    }

    syncTopbarContext() {
        // The current UI keeps page titles inside each workspace page.
    }

    setupWebSocket() {
        // Simple polling for records updates
        setInterval(async () => {
            if (this.isAuthenticated()) {
                const hash = window.location.hash || '';
                const isRecordsPage = hash === '#/records';
                if (!isRecordsPage) return;
                await this.loadRecords();
            }
        }, 10000);
    }

    toggleArchivedKeys() {
        const container = document.getElementById('archivedKeysContainer');
        const chevron = document.getElementById('archivedChevron');
        if (!container) return;
        
        const isHidden = container.classList.contains('d-none');
        if (isHidden) {
            container.classList.remove('d-none');
            if (chevron) chevron.style.transform = 'rotate(180deg)';
            this._showArchivedQuizzes = true;
            this.renderArchivedQuizzes();
        } else {
            container.classList.add('d-none');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            this._showArchivedQuizzes = false;
        }
    }

    renderQuizList(search = '') {
        const container = document.getElementById('quizList');
        const emptyState = document.getElementById('quizEmptyState');
        if (!container) return;
        
        const filtered = this.quizzes.filter(q => 
            String(q.title).toLowerCase().includes(search.toLowerCase())
        );

        if (filtered.length === 0) {
            container.innerHTML = '';
            if (emptyState) emptyState.classList.remove('d-none');
            return;
        } else {
            if (emptyState) emptyState.classList.add('d-none');
        }

        container.innerHTML = filtered.map(quiz => `
            <tr>
                <td class="ps-4">
                    <div class="fw-bold text-dark">${escapeHtml(quiz.title)}</div>
                    <div class="small text-muted">ID: ${quiz.id}</div>
                </td>
                <td>
                    <span class="badge bg-light text-dark border fw-normal">
                        <i class="fas fa-list-ol me-1 text-primary"></i> ${quiz.questionCount} Questions
                    </span>
                </td>
                <td>
                    <span class="badge bg-light text-dark border fw-normal">
                                                <i class="fas fa-check-circle me-1 text-success"></i> ${quiz.passingScore || PASSING_SCORE}% Passing
                    </span>
                </td>
                <td>
                    <span class="badge ${quiz.format === 'normal' ? 'bg-success bg-opacity-10 text-success border border-success border-opacity-25' : 'bg-primary bg-opacity-10 text-primary border border-primary border-opacity-25'} px-2">
                        ${quiz.format === 'normal' ? 'Single-Subject' : 'Multi-Subject'}
                    </span>
                </td>
                <td>
                    <div class="small text-muted">
                        <i class="far fa-calendar-alt me-1"></i> ${new Date(quiz.createdAt || Date.now()).toLocaleDateString()}
                    </div>
                </td>
                <td class="text-end pe-4">
                    <div class="btn-group shadow-sm">
                        <button class="btn btn-sm btn-outline-primary" onclick="app.selectQuiz('${quiz.id}')" title="Generate & Print">
                            <i class="fas fa-print me-1"></i> Print
                        </button>
                        <button class="btn btn-sm btn-outline-warning" onclick="app.showAnswerKeyFormById('${quiz.id}')" title="Set Answer Key">
                            <i class="fas fa-key me-1"></i> Key
                        </button>
                        <button class="btn btn-sm btn-outline-secondary" onclick="app.editQuiz('${quiz.id}')" title="Edit">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="app.deleteQuiz('${quiz.id}')" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
        this.populateExamPage();
    }

    getFilteredRecords() {
        const search = (document.getElementById('recordsSearch')?.value || '').trim().toLowerCase();
        const statusFilter = (document.getElementById('recordsStatusFilter')?.value || '').trim().toUpperCase();
        const quizFilter = (document.getElementById('recordsQuizFilter')?.value || '');
        const entryFilter = (document.getElementById('recordsEntryFilter')?.value || '');
        const residencyFilter = (document.getElementById('recordsResidencyFilter')?.value || '');
        const equityFilter = (document.getElementById('recordsEquityFilter')?.value || '');

        return (Array.isArray(this.records) ? this.records : []).filter((record) => {
            const percentage = Number(record?.percentage || 0);
            
            // Get the quiz's passing score if available, default to 75
            let passingScore = 75;
            const quizId = record?.quiz_id || record?.quizId;
            if (quizId) {
                const quiz = this.quizzes?.find(q => String(q.id) === String(quizId));
                if (quiz && quiz.passingScore) {
                    passingScore = quiz.passingScore;
                }
            }
            
            const normalizedStatus = String(record?.status || (percentage >= passingScore ? 'PASS' : 'FAIL')).toUpperCase();
            const reviewStatus = String(record?.review_status || '').toLowerCase();
            const needsReview = reviewStatus === 'needs_review' || (percentage < passingScore && reviewStatus === 'auto_scanned');

            if (statusFilter === 'PASS' && normalizedStatus !== 'PASS') return false;
            if (statusFilter === 'FAIL' && normalizedStatus !== 'FAIL') return false;
            if (statusFilter === 'REVIEW' && !needsReview) return false;
            
            if (quizFilter && String(record.quiz_id) !== quizFilter) return false;
            if (entryFilter && record.entry_type !== entryFilter) return false;
            if (residencyFilter && record.residency_type !== residencyFilter) return false;
            if (equityFilter && record.special_equity_group !== equityFilter) return false;

            if (!search) return true;
            const haystack = [
                record?.student_name,
                record?.student_id,
                record?.quiz_title,
                record?.course,
                record?.entry_type,
                record?.residency_type,
                record?.special_equity_group
            ].map((value) => String(value || '').toLowerCase()).join(' ');

            return haystack.includes(search);
        });
    }

    populateRecordsFilters() {
        const quizFilter = document.getElementById('recordsQuizFilter');
        const entryFilter = document.getElementById('recordsEntryFilter');
        const equityFilter = document.getElementById('recordsEquityFilter');

        if (!quizFilter || !entryFilter || !equityFilter) return;

        // Save current selections
        const currentQuiz = quizFilter.value;
        const currentEntry = entryFilter.value;
        const currentEquity = equityFilter.value;

        // Quizzes (Exams) - Show all created exams
        const quizzes = Array.isArray(this.quizzes) ? this.quizzes : [];
        quizFilter.innerHTML = '<option value="">All Exams</option>' + 
            quizzes.map(q => `<option value="${q.id}">${escapeHtml(q.title)}</option>`).join('');
        quizFilter.value = currentQuiz;

        // Entry Types - Static options as requested
        const entryTypes = ["New Student", "Transferee"];
        entryFilter.innerHTML = '<option value="">All Entry Types</option>' + 
            entryTypes.map(t => `<option value="${t}">${escapeHtml(t)}</option>`).join('');
        entryFilter.value = currentEntry;

        // Residency Filter
        const residencyFilter = document.getElementById('recordsResidencyFilter');
        if (residencyFilter) {
            const currentResidency = residencyFilter.value;
            const residencyTypes = ["Passinhon", "Non-Passinhon"];
            residencyFilter.innerHTML = '<option value="">All Residency</option>' + 
                residencyTypes.map(t => `<option value="${t}">${escapeHtml(t)}</option>`).join('');
            residencyFilter.value = currentResidency;
        }

        // Equity Groups - Static options as requested
        const equityGroups = ["PWDs", "IPs", "Solo Parent", "Magna Carta"];
        equityFilter.innerHTML = '<option value="">All Equity Groups</option>' + 
            equityGroups.map(g => `<option value="${g}">${escapeHtml(g)}</option>`).join('');
        equityFilter.value = currentEquity;
    }

    renderRecords() {
        const container = document.getElementById('recordsList');
        const emptyState = document.getElementById('recordsEmptyState');
        if (!container) return;

        const filteredRecords = this.getFilteredRecords();

        if (filteredRecords.length === 0) {
            container.innerHTML = '';
            if (emptyState) emptyState.classList.remove('d-none');
            return;
        } else {
            if (emptyState) emptyState.classList.add('d-none');
        }

        container.innerHTML = filteredRecords.map(record => {
            const needsReview = record.review_status === 'needs_review' || (record.percentage < 75 && record.review_status === 'auto_scanned');
            
            return `
                <tr class="${needsReview ? 'table-warning' : ''}">
                    <td class="ps-4">
                        <div class="fw-bold text-dark">${escapeHtml(record.student_name || 'Unnamed')}</div>
                        <div class="small text-muted">Sheet ${escapeHtml(record.sheet_id || 'No Sheet ID')}</div>
                    </td>
                    <td>
                        <div class="small fw-semibold text-dark">${escapeHtml(record.course || 'Unknown')}</div>
                        <div class="x-small text-muted">
                            ${record.age ? `Age: ${escapeHtml(record.age)}` : ''}
                        </div>
                    </td>
                    <td>
                        <div class="d-flex flex-column gap-1">
                            <div class="d-flex gap-1">
                                <span class="badge bg-info bg-opacity-10 text-info border border-info border-opacity-10 x-small" style="width: fit-content;">${escapeHtml(record.entry_type || 'New')}</span>
                                <span class="badge bg-primary bg-opacity-10 text-primary border border-primary border-opacity-10 x-small" style="width: fit-content;">${escapeHtml(record.residency_type || 'Passinhon')}</span>
                            </div>
                            <span class="badge bg-warning bg-opacity-10 text-warning border border-warning border-opacity-10 x-small" style="width: fit-content;">${escapeHtml(record.special_equity_group || 'None')}</span>
                        </div>
                    </td>
                    <td>
                        <div class="small fw-bold text-dark mb-1">${escapeHtml(record.quiz_title || 'Entrance Exam')}</div>
                        <div class="d-flex align-items-center gap-2">
                            <span class="badge bg-${record.status === 'PASS' ? 'success' : 'danger'} bg-opacity-10 text-${record.status === 'PASS' ? 'success' : 'danger'} border border-${record.status === 'PASS' ? 'success' : 'danger'} border-opacity-10 x-small">
                                ${record.score}/${record.total_questions || 0} (${record.percentage}%)
                            </span>
                            ${needsReview ? '<span class="badge bg-warning text-dark x-small"><i class="fas fa-exclamation-triangle"></i></span>' : ''}
                        </div>
                    </td>
                    <td>
                        <div class="small text-muted">
                            ${new Date(record.timestamp).toLocaleDateString([], { dateStyle: 'short' })}<br>
                            <span class="x-small opacity-75">${new Date(record.timestamp).toLocaleTimeString([], { timeStyle: 'short' })}</span>
                        </div>
                    </td>
                    <td class="text-end pe-4">
                        <div class="btn-group btn-group-sm">
                            <button class="btn btn-outline-primary" onclick="app.showRecordDetails(${record.id})" title="View Details">
                                <i class="fas fa-eye"></i>
                            </button>
                            <button class="btn btn-outline-success" onclick="app.editRecord(${record.id})" title="Manual Correction">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-outline-danger" onclick="app.deleteRecord(${record.id})" title="Delete Record">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    async exportRecordsToExcel() {
        const filteredRecords = this.getFilteredRecords();
        if (!filteredRecords.length) {
            this.showToast('No records to export', 'warning');
            return;
        }

        if (typeof ExcelJS === 'undefined') {
            this.showToast('Excel export library is unavailable', 'danger');
            return;
        }

        try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Records');
            worksheet.columns = [
                { header: 'Student Name', key: 'student_name', width: 28 },
                { header: 'Sheet ID', key: 'sheet_id', width: 18 },
                { header: 'Exam', key: 'quiz_title', width: 26 },
                { header: 'Course', key: 'course', width: 22 },
                { header: 'Entry Type', key: 'entry_type', width: 16 },
                { header: 'Residency', key: 'residency_type', width: 16 },
                { header: 'Equity Group', key: 'special_equity_group', width: 18 },
                { header: 'Score', key: 'score', width: 10 },
                { header: 'Total Questions', key: 'total_questions', width: 16 },
                { header: 'Percentage', key: 'percentage', width: 12 },
                { header: 'Status', key: 'status', width: 12 },
                { header: 'Saved At', key: 'timestamp', width: 24 }
            ];

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true };
            headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
            headerRow.eachCell((cell) => {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFE8F1FF' }
                };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFD0D7DE' } },
                    left: { style: 'thin', color: { argb: 'FFD0D7DE' } },
                    bottom: { style: 'thin', color: { argb: 'FFD0D7DE' } },
                    right: { style: 'thin', color: { argb: 'FFD0D7DE' } }
                };
            });

            filteredRecords.forEach((record) => {
                const percentage = Number(record?.percentage || 0);
                const status = String(record?.status || (percentage >= PASSING_SCORE ? 'PASS' : 'FAIL')).toUpperCase();
                worksheet.addRow({
                    student_name: record?.student_name || '',
                    sheet_id: record?.sheet_id || '',
                    quiz_title: record?.quiz_title || 'OCR Review',
                    course: record?.course || '',
                    entry_type: record?.entry_type || '',
                    special_equity_group: record?.special_equity_group || '',
                    score: Number(record?.score || 0),
                    total_questions: Number(record?.total_questions || 0),
                    percentage,
                    status,
                    timestamp: record?.timestamp ? new Date(record.timestamp).toLocaleString() : ''
                });
            });

            worksheet.views = [{ state: 'frozen', ySplit: 1 }];
            worksheet.autoFilter = {
                from: 'A1',
                to: 'K1'
            };

            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const dateStamp = new Date().toISOString().slice(0, 10);
            link.href = url;
            link.download = `scancheck-records-${dateStamp}.xlsx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            this.showToast('Records exported to Excel', 'success');
        } catch (error) {
            console.error('Failed exporting records to Excel:', error);
            this.showToast('Excel export failed. Please try again.', 'danger');
        }
    }

    showRecordDetails(recordId) {
        const record = this.records.find(r => r.id === recordId);
        if (!record) return;

        const answers = Array.isArray(record.answers)
            ? record.answers
            : (() => {
                try {
                    return JSON.parse(record.answers || '[]');
                } catch (e) {
                    return [];
                }
            })();

        const answerMarkup = answers.length
            ? `<div class="row row-cols-6 g-1 mt-2" style="max-height: 300px; overflow-y: auto; padding: 10px; background: #f8f9fa; border-radius: 12px;">${answers.map((answer, index) => `
                <div class="col">
                    <div class="d-flex flex-column align-items-center p-1 border rounded bg-white shadow-xs">
                        <span class="x-small text-muted fw-bold" style="font-size: 0.6rem;">${index + 1}</span>
                        <span class="fw-bold ${answer ? 'text-primary' : 'text-danger'}" style="font-size: 0.85rem;">${escapeHtml(answer || '-')}</span>
                    </div>
                </div>
            `).join('')}</div>`
            : '<p class="text-muted mb-0">No answers saved.</p>';

        const rawText = escapeHtml(record.raw_text || 'No OCR text saved.');
        const imageUrl = record.image_path ? (record.image_path.startsWith('data:') ? record.image_path : `/api${record.image_path}`) : null;
        const image = imageUrl ? `
            <div class="card border-0 shadow-sm overflow-hidden rounded-4">
                <div class="card-header bg-white border-0 py-2">
                    <span class="small fw-bold text-muted"><i class="fas fa-image me-1"></i> Scanned Document</span>
                </div>
                <img src="${imageUrl}" class="img-fluid" alt="Saved record image" style="max-height: 450px; object-fit: contain;">
            </div>
        ` : '';

        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'fixed-top w-100 h-100 d-flex align-items-center justify-content-center';
        modalOverlay.style.background = 'rgba(0,0,0,0.5)';
        modalOverlay.style.zIndex = '2000';
        modalOverlay.id = 'recordDetailsOverlay';
        
        modalOverlay.innerHTML = `
            <div class="card border-0 shadow-lg animate-fade-up" style="width: 95%; max-width: 1000px; max-height: 90vh; border-radius: 20px; overflow: hidden;">
                <div class="card-header bg-white border-bottom-0 p-4 d-flex justify-content-between align-items-center">
                    <h5 class="mb-0 fw-bold text-dark"><i class="fas fa-file-invoice text-primary me-2"></i> Record Details</h5>
                    <button type="button" class="btn-close" onclick="document.getElementById('recordDetailsOverlay').remove()"></button>
                </div>
                <div class="card-body p-0 overflow-auto">
                    <div class="row g-0">
                        <div class="col-lg-7 p-4 border-end">
                            <div class="row g-4 mb-4">
                                <div class="col-md-6">
                                    <div class="p-3 bg-light rounded-4">
                                        <div class="small text-muted text-uppercase fw-bold mb-2" style="font-size: 0.65rem;">Student Information</div>
                                        <div class="fw-bold text-dark mb-1">${escapeHtml(record.student_name || 'N/A')}</div>
                                        <div class="small text-muted">Sheet: ${escapeHtml(record.sheet_id || 'N/A')} | Age: ${escapeHtml(record.age || 'N/A')}</div>
                                    </div>
                                </div>
                                <div class="col-md-6">
                                    <div class="p-3 bg-light rounded-4">
                                        <div class="small text-muted text-uppercase fw-bold mb-2" style="font-size: 0.65rem;">Exam & Results</div>
                                        <div class="fw-bold text-dark mb-1">${escapeHtml(record.quiz_title || 'N/A')}</div>
                                        <div class="d-flex align-items-center gap-2">
                                            <span class="badge bg-primary rounded-pill px-3">${record.score} / ${record.total_questions}</span>
                                            <span class="badge bg-${record.status === 'PASS' ? 'success' : 'danger'} rounded-pill px-3">${record.status}</span>
                                        </div>
                                    </div>
                                </div>
                                <div class="col-12">
                                    <div class="p-3 bg-light rounded-4">
                                        <div class="small text-muted text-uppercase fw-bold mb-2" style="font-size: 0.65rem;">Additional Info</div>
                                        <div class="row g-2">
                                            <div class="col-6 small text-truncate" title="${escapeHtml(record.course)}"><strong>Course:</strong> ${escapeHtml(record.course || 'N/A')}</div>
                                            <div class="col-6 small"><strong>Date:</strong> ${escapeHtml(record.exam_date_time || 'N/A')}</div>
                                            <div class="col-6 small"><strong>Entry:</strong> ${escapeHtml(record.entry_type || 'N/A')}</div>
                                            <div class="col-6 small"><strong>Residency:</strong> ${escapeHtml(record.residency_type || 'N/A')}</div>
                                            <div class="col-6 small"><strong>Equity:</strong> ${escapeHtml(record.special_equity_group || 'None')}</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            
                            <h6 class="fw-bold text-dark mb-3"><i class="fas fa-th text-primary me-2"></i> Detected Answers</h6>
                            ${answerMarkup}
                        </div>
                        <div class="col-lg-5 p-4 bg-light bg-opacity-50">
                            ${image}
                            <div class="mt-4">
                                <h6 class="small fw-bold text-muted text-uppercase mb-2">Raw OCR Text</h6>
                                <div class="p-3 bg-white border rounded-4 small text-muted" style="max-height: 150px; overflow-y: auto; font-family: monospace; font-size: 11px;">
                                    ${rawText.replace(/\n/g, '<br>')}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card-footer bg-white border-top-0 p-4 d-flex justify-content-end gap-2">
                    <button class="btn btn-outline-success rounded-pill px-4" onclick="document.getElementById('recordDetailsOverlay').remove(); app.editRecord(${record.id})">
                        <i class="fas fa-edit me-1"></i> Correct Manually
                    </button>
                    <button class="btn btn-light rounded-pill px-4" onclick="document.getElementById('recordDetailsOverlay').remove()">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(modalOverlay);
    }

    renderSystems() {
        const container = document.getElementById('systemsList');
        if (!container) return;
        if (this.systems.length === 0) {
            container.innerHTML = '<p class="text-muted">No systems found.</p>';
            return;
        }

        container.innerHTML = this.systems.map(system => `
            <div class="border rounded p-3 mb-2">
                <strong>${system.name}</strong>
                <p class="small text-muted">${system.description}</p>
            </div>
        `).join('');
    }

    renderScanResults(search = '', quizFilter = '', entryFilter = '', residencyFilter = '', equityFilter = '') {
        const container = document.getElementById('scanResults');
        if (!container) return;

        // Populate quiz filter if not already populated
        const filterSelect = document.getElementById('scanQuizFilter');
        if (filterSelect && filterSelect.options.length <= 1) {
            this.quizzes.forEach(q => {
                const opt = document.createElement('option');
                opt.value = q.id;
                opt.textContent = q.title;
                filterSelect.appendChild(opt);
            });
        }

        let filtered = this.scanResults;
        
        if (quizFilter) {
            filtered = filtered.filter(s => String(s.quizId || s.quiz_id) === String(quizFilter));
        }

        if (entryFilter) {
            filtered = filtered.filter(s => String(s.entryType || s.entry_type || '').toLowerCase() === entryFilter.toLowerCase());
        }

        if (residencyFilter) {
            filtered = filtered.filter(s => String(s.residencyType || s.residency_type || '').toLowerCase() === residencyFilter.toLowerCase());
        }

        if (equityFilter) {
            filtered = filtered.filter(s => String(s.specialEquityGroup || s.special_equity_group || '').toLowerCase() === equityFilter.toLowerCase());
        }
        
        if (search) {
            filtered = filtered.filter(s => 
                String(s.studentName || s.student_name || '').toLowerCase().includes(search.toLowerCase()) ||
                String(s.quizTitle || s.quiz_title || '').toLowerCase().includes(search.toLowerCase())
            );
        }

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-tasks empty-state-icon"></i>
                    <h6 class="empty-state-title">No results found</h6>
                    <p class="empty-state-description small">Try adjusting your search or filters.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="row g-4">
                ${filtered.map(scan => {
                    const name = scan.studentName || scan.student_name || 'Student';
                    const pct = Number(scan.percentage) || 0;
                    const tot = scan.totalQuestions != null ? scan.totalQuestions : scan.total_questions;
                    const sc = scan.score != null ? scan.score : 0;
                    const needsReview = scan.review_status === 'needs_review' || (pct < 75 && scan.review_status === 'auto_scanned');
                    
                    return `
                        <div class="col-12">
                            <div class="card shadow-sm border-0 mb-3 hover-shadow-sm transition-all ${needsReview ? 'border-start border-4 border-warning' : ''}">
                                <div class="card-body p-4">
                                    <div class="d-flex justify-content-between align-items-center flex-wrap gap-3">
                                        <div class="d-flex align-items-center gap-4">
                                            <div class="bg-primary bg-opacity-10 text-primary rounded-circle d-flex align-items-center justify-content-center" style="width: 56px; height: 56px; flex-shrink: 0;">
                                                <i class="fas fa-user-graduate fs-4"></i>
                                            </div>
                                            <div>
                                                <h5 class="fw-bold text-dark mb-1">${escapeHtml(name)}</h5>
                                                <div class="d-flex flex-wrap gap-2 mb-1">
                                                    <span class="badge bg-light text-dark border fw-normal">${escapeHtml(scan.quizTitle || scan.quiz_title || 'Entrance Exam')}</span>
                                                    ${(scan.entryType || scan.entry_type) ? `<span class="badge bg-info bg-opacity-10 text-info border border-info border-opacity-10 x-small">${escapeHtml(scan.entryType || scan.entry_type)}</span>` : ''}
                                                    ${(scan.residencyType || scan.residency_type) ? `<span class="badge bg-primary bg-opacity-10 text-primary border border-primary border-opacity-10 x-small">${escapeHtml(scan.residencyType || scan.residency_type)}</span>` : ''}
                                                    ${(scan.specialEquityGroup || scan.special_equity_group) ? `<span class="badge bg-warning bg-opacity-10 text-warning border border-warning border-opacity-10 x-small">${escapeHtml(scan.specialEquityGroup || scan.special_equity_group)}</span>` : ''}
                                                </div>
                                                <div class="x-small text-muted">
                                                    <i class="far fa-clock me-1"></i> ${scan.timestamp ? new Date(scan.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Just now'}
                                                </div>
                                            </div>
                                        </div>
                                        <div class="d-flex align-items-center gap-4">
                                            <div class="text-end">
                                                <div class="fs-3 fw-bold text-${pct >= PASSING_SCORE ? 'success' : pct >= 50 ? 'warning' : 'danger'}">${pct.toFixed(1)}%</div>
                                                <div class="small fw-bold text-muted">${sc} / ${tot || 0} Correct</div>
                                            </div>
                                            <div class="btn-group">
                                                <button class="btn btn-primary rounded-pill px-4 shadow-sm btn-sm" onclick="app.showDetailedResults(${scan.id})">
                                                    <i class="fas fa-eye me-1"></i> Review
                                                </button>
                                                <button class="btn btn-outline-secondary btn-sm rounded-circle ms-2" onclick="app.exportToCSV(${scan.id})" title="Export CSV">
                                                    <i class="fas fa-download"></i>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                    ${needsReview ? `
                                        <div class="mt-3 p-2 bg-warning bg-opacity-10 rounded border border-warning border-opacity-25 d-flex align-items-center gap-2">
                                            <i class="fas fa-exclamation-triangle text-warning"></i>
                                            <span class="x-small fw-bold text-dark">This scan requires manual review due to low score or alignment uncertainty.</span>
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    exportToCSV(scanId) {
        const scan = this.scanResults.find(s => s.id === scanId);
        if (!scan) return;

        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Question,Student Answer\n";
        const answers = scan.answers || [];
        answers.forEach((ans, i) => {
            csvContent += `${i + 1},${ans || '-'}\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        const rawName = scan.studentName || scan.student_name || 'student';
        link.setAttribute("download", `results_${String(rawName).replace(/\s+/g, '_')}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    showDetailedResults(scanId) {
        const scan = this.scanResults.find(s => s.id === scanId);
        if (!scan) return;

        const quizId = scan.quizId != null ? scan.quizId : scan.quiz_id;
        const stName = scan.studentName || scan.student_name || 'Student';
        const totQ = scan.totalQuestions != null ? scan.totalQuestions : scan.total_questions;
        const pct = Number(scan.percentage) || 0;

        // Get correct answers for comparison
        this.loadAnswerKey(quizId).then(correctAnswers => {
            const nQ = totQ || (scan.answers && scan.answers.length) || 0;
            const ans = scan.answers || [];
            
            const tableRows = [];
            for (let i = 0; i < nQ; i++) {
                const studentAnswer = (ans[i] || '').trim().toUpperCase();
                const correctAnswer = (correctAnswers[i] || '').trim().toUpperCase();
                const isCorrect = studentAnswer === correctAnswer && studentAnswer !== '';
                const isEmpty = studentAnswer === '';
                
                tableRows.push(`
                    <tr style="background: ${isCorrect ? '#f0fff4' : (isEmpty ? '#fff5f5' : '#fff5f5')};">
                        <td class="text-center small fw-bold text-muted" style="width: 50px;">${i + 1}</td>
                        <td class="text-center fw-bold ${isCorrect ? 'text-success' : 'text-danger'}" style="width: 100px;">${escapeHtml(studentAnswer || '-')}</td>
                        <td class="text-center text-muted" style="width: 100px;">${escapeHtml(correctAnswer || '-')}</td>
                        <td class="text-center" style="width: 50px;">
                            ${isCorrect ? '<i class="fas fa-check-circle text-success"></i>' : (isEmpty ? '<i class="fas fa-minus-circle text-muted opacity-50"></i>' : '<i class="fas fa-times-circle text-danger"></i>')}
                        </td>
                    </tr>
                `);
            }

            const detailsHtml = `
                <div class="fixed-top w-100 h-100 d-flex align-items-center justify-content-center" style="background: rgba(0,0,0,0.5); z-index: 2000;" id="detailedResultsOverlay">
                    <div class="card border-0 shadow-lg animate-fade-up" style="width: 95%; max-width: 900px; max-height: 90vh; border-radius: 20px; overflow: hidden;">
                        <div class="card-header bg-white border-bottom-0 p-4 d-flex justify-content-between align-items-center">
                            <h5 class="mb-0 fw-bold text-dark"><i class="fas fa-chart-line text-primary me-2"></i> Detailed Results: ${escapeHtml(stName)}</h5>
                            <button type="button" class="btn-close" onclick="document.getElementById('detailedResultsOverlay').remove()"></button>
                        </div>
                        <div class="card-body p-4 overflow-auto">
                            <div class="row g-4 mb-4">
                                <div class="col-md-4">
                                    <div class="p-3 bg-primary bg-opacity-10 rounded-4 border border-primary border-opacity-10">
                                        <div class="small text-primary text-uppercase fw-bold mb-1" style="font-size: 0.65rem;">Total Score</div>
                                        <div class="h4 fw-bold text-primary mb-0">${scan.score} / ${totQ}</div>
                                    </div>
                                </div>
                                <div class="col-md-4">
                                    <div class="p-3 bg-success bg-opacity-10 rounded-4 border border-success border-opacity-10">
                                        <div class="small text-success text-uppercase fw-bold mb-1" style="font-size: 0.65rem;">Percentage</div>
                                        <div class="h4 fw-bold text-success mb-0">${pct.toFixed(1)}%</div>
                                    </div>
                                </div>
                                <div class="col-md-4">
                                    <div class="p-3 bg-light rounded-4 border">
                                        <div class="small text-muted text-uppercase fw-bold mb-1" style="font-size: 0.65rem;">Status</div>
                                        <span class="badge bg-${scan.status === 'PASS' ? 'success' : 'danger'} rounded-pill px-3">${scan.status}</span>
                                    </div>
                                </div>
                            </div>

                            <div class="row g-4">
                                <div class="col-md-7">
                                    <h6 class="fw-bold text-dark mb-3"><i class="fas fa-list-ol me-2"></i> Question Breakdown</h6>
                                    <div class="table-responsive rounded-4 border shadow-xs" style="max-height: 400px;">
                                        <table class="table table-hover mb-0">
                                            <thead class="bg-light sticky-top">
                                                <tr>
                                                    <th class="text-center small text-muted text-uppercase">Q#</th>
                                                    <th class="text-center small text-muted text-uppercase">Student</th>
                                                    <th class="text-center small text-muted text-uppercase">Correct</th>
                                                    <th class="text-center small text-muted text-uppercase">Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                ${tableRows.join('')}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                                <div class="col-md-5">
                                    <h6 class="fw-bold text-dark mb-3"><i class="fas fa-image me-2"></i> Scanned Document</h6>
                                    ${scan.photo ? `
                                        <div class="card border-0 shadow-sm overflow-hidden rounded-4">
                                            <img src="${scan.photo}" class="img-fluid" alt="Captured Sheet" style="cursor: zoom-in; max-height: 400px; object-fit: contain;" onclick="window.open(this.src, '_blank')">
                                            <div class="card-footer bg-white border-0 py-2 text-center">
                                                <span class="x-small text-muted"><i class="fas fa-search-plus me-1"></i> Click image to enlarge</span>
                                            </div>
                                        </div>
                                    ` : `
                                        <div class="d-flex flex-column align-items-center justify-content-center p-5 bg-light rounded-4 border border-dashed">
                                            <i class="fas fa-image text-muted opacity-25 mb-2" style="font-size: 2rem;"></i>
                                            <span class="small text-muted">No document image available</span>
                                        </div>
                                    `}
                                </div>
                            </div>
                        </div>
                        <div class="card-footer bg-white border-top-0 p-4 d-flex justify-content-end">
                            <button class="btn btn-light rounded-pill px-4 fw-bold" onclick="document.getElementById('detailedResultsOverlay').remove()">Close</button>
                        </div>
                    </div>
                </div>
            `;
            
            const overlay = document.createElement('div');
            overlay.innerHTML = detailsHtml;
            document.body.appendChild(overlay.firstElementChild);
        });
    }

    selectQuiz(quizId) {
        const quiz = this.quizzes.find(q => q.id == quizId);
        if (quiz) {
            scanCheckConfig.currentQuiz = quiz;
            scanCheckConfig.currentFormat = quiz.format || 'multi-subject';
            localStorage.setItem('scancheck_current_quiz', JSON.stringify(quiz));
            localStorage.setItem('scancheck_sheet_format', quiz.format || 'multi-subject');
            
            if (quiz.format === 'normal' && window.normalAnswerSheetGenerator) {
                window.normalAnswerSheetGenerator.generate(quiz);
            } else if (window.answerSheetGenerator) {
                window.answerSheetGenerator.generate(quiz);
            }
            
            this.showToast(`Selected: ${quiz.title}`, 'info');
            location.hash = '#/exam';
        }
    }

    showAnswerKeyFormById(quizId) {
        const quiz = this.quizzes.find(q => q.id == quizId);
        if (quiz) {
            location.hash = '#/answer-key';
            setTimeout(() => this.handleAnswerKeyQuizSelect(quiz.id, true), 100);
        }
    }

    async loadAnswerKey(quizId) {
        try {
            const answerKey = await this.apiCallWithAuth(`/api/quizzes/${quizId}/answer-key`, {}, 'loadAnswerKey');
            return answerKey.answers || [];
        } catch (error) {
            console.error('Error loading answer key:', error);
            return [];
        }
    }

    async saveAnswerKey(quizId, answers) {
        try {
            await this.apiCallWithAuth(`/api/quizzes/${quizId}/answer-key`, {
                method: 'POST',
                body: JSON.stringify({ answers })
            }, 'saveAnswerKey');
            toastManager.showSuccess('Answer key saved successfully!');
            return true;
        } catch (error) {
            console.error('Error saving answer key:', error);
            // Error already handled by apiCallWithAuth
            return false;
        }
    }

    isAnswerKeyFormVisible() {
        const form = document.getElementById('answerKeyForm');
        return Boolean(form && !form.classList.contains('d-none'));
    }

    shouldBlockAnswerKeyNavigation(nextHash) {
        return this.answerKeyDirty && this.isAnswerKeyFormVisible() && String(nextHash || '') !== '#/answer-key';
    }

    setAnswerKeyDirty(isDirty) {
        this.answerKeyDirty = Boolean(isDirty);
        const badge = document.getElementById('answerKeyDirtyBadge');
        if (badge) {
            badge.classList.toggle('d-none', !this.answerKeyDirty);
        }
    }

    getAnswerKeyActiveQuestionIndexes() {
        if (!this.answerKeyPlan) return [];
        const indexes = [];
        this.answerKeyPlan.sections.forEach(sec => {
            for (let i=0; i<sec.count; i++) {
                indexes.push(sec.startIndex + i);
            }
        });
        return indexes;
    }

    getAnswerKeyQuestionBox(questionIndex) {
        return document.querySelector(`#answerKeySubjectContent .answer-key-question[data-question="${questionIndex}"]`);
    }

    setAnswerKeyFocus(questionIndex, { scrollIntoView = false } = {}) {
        const qNum = Number.parseInt(String(questionIndex || 0), 10);
        if (!Number.isFinite(qNum) || qNum <= 0) return;

        document.querySelectorAll('#answerKeySubjectContent .answer-key-question.answer-key-question-focused')
            .forEach((el) => el.classList.remove('answer-key-question-focused'));

        const target = this.getAnswerKeyQuestionBox(qNum);
        if (!target) return;
        target.classList.add('answer-key-question-focused');
        target.focus({ preventScroll: !scrollIntoView });
        if (scrollIntoView) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        this.answerKeyFocusQuestion = qNum;
    }

    setAnswerKeyAnswer(questionIndex, value, { markDirty = true, render = false } = {}) {
        const qNum = Number.parseInt(String(questionIndex || 0), 10);
        const answer = String(value || '').toUpperCase();
        if (!this.answerKeyDraftAnswers) return false;
        
        this.answerKeyDraftAnswers[qNum - 1] = answer;

        if (markDirty) this.setAnswerKeyDirty(true);
        if (render) {
            this.renderAnswerKeyTabs();
            this.renderAnswerKeyActiveSubject();
        }
        return true;
    }

    fillAnswerKeySubject(subjectCode, letter) {
        const targetCode = String(subjectCode || '').toUpperCase();
        const answer = String(letter || '').toUpperCase();
        if (!targetCode || !answer || !this.answerKeyPlan) return;
        
        const section = this.answerKeyPlan.sections.find(s => s.code === targetCode);
        if (!section) return;
        
        for (let i = 0; i < section.count; i++) {
            const globalIndex = section.startIndex + i - 1;
            this.answerKeyDraftAnswers[globalIndex] = answer;
        }
        
        this.setAnswerKeyDirty(true);
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
        this.updateAnswerKeySummary();
    }

    clearAnswerKeySubject(subjectCode) {
        const targetCode = String(subjectCode || '').toUpperCase();
        if (!targetCode || !this.answerKeyPlan) return;
        
        const section = this.answerKeyPlan.sections.find(s => s.code === targetCode);
        if (!section) return;
        
        for (let i = 0; i < section.count; i++) {
            const globalIndex = section.startIndex + i - 1;
            this.answerKeyDraftAnswers[globalIndex] = '';
        }
        
        this.setAnswerKeyDirty(true);
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
        this.updateAnswerKeySummary();
    }

    randomizeAnswerKeySubject(subjectCode) {
        const targetCode = String(subjectCode || '').toUpperCase();
        if (!targetCode || !this.answerKeyPlan) return;
        
        const options = Array.isArray(this.answerKeyOptionSet) && this.answerKeyOptionSet.length > 0 ? this.answerKeyOptionSet : ['A', 'B', 'C', 'D'];
        const section = this.answerKeyPlan.sections.find(s => s.code === targetCode);
        if (!section) return;
        
        for (let i = 0; i < section.count; i++) {
            const globalIndex = section.startIndex + i - 1;
            const random = options[Math.floor(Math.random() * options.length)];
            this.answerKeyDraftAnswers[globalIndex] = random;
        }
        
        this.setAnswerKeyDirty(true);
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
        this.updateAnswerKeySummary();
    }

    clearAnswerKeyAll() {
        if (!this.answerKeyDraftAnswers) return;
        this.getAnswerKeyActiveQuestionIndexes().forEach((q) => {
            this.answerKeyDraftAnswers[q - 1] = '';
        });
        this.setAnswerKeyDirty(true);
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
        this.updateAnswerKeySummary();
    }

    collectAnswerKeyAnswers() {
        this.syncAnswerKeyDOMToDraft();
        const activeQuestions = this.getAnswerKeyActiveQuestionIndexes();
        const answers = [];
        for (let i = 0; i < this.answerKeyDraftAnswers.length; i++) {
            if (activeQuestions.includes(i + 1)) {
                answers.push(this.answerKeyDraftAnswers[i] || '');
            } else {
                answers.push('');
            }
        }
        return {
            activeQuestions,
            answers
        };
    }

    updateAnswerKeySummary() {
        if (!this.answerKeyPlan) return;
        this.syncAnswerKeyDOMToDraft();
        
        const activeCount = this.answerKeyPlan.totalQuestions;
        let answeredCount = 0;
        
        this.getAnswerKeyActiveQuestionIndexes().forEach(q => {
            if (this.answerKeyDraftAnswers[q - 1]) answeredCount++;
        });
        
        const blankCount = Math.max(0, activeCount - answeredCount);

        const activeEl = document.getElementById('answerKeySummaryActive');
        const answeredEl = document.getElementById('answerKeySummaryAnswered');
        const blankEl = document.getElementById('answerKeySummaryBlank');
        const progressEl = document.getElementById('answerKeyCompletionProgress');
        const mismatchEl = document.getElementById('answerKeyMismatchAlert');
        const saveBtn = document.getElementById('answerKeySaveBtn');

        if (activeEl) activeEl.textContent = String(activeCount);
        if (answeredEl) answeredEl.textContent = String(answeredCount);
        if (blankEl) blankEl.textContent = String(blankCount);
        if (progressEl) {
            const pct = activeCount > 0 ? Math.round((answeredCount / activeCount) * 100) : 0;
            progressEl.style.width = `${pct}%`;
            progressEl.setAttribute('aria-valuenow', String(pct));
            progressEl.title = `${pct}% complete`;
        }

        const quiz = scanCheckConfig.currentQuiz;
        const expected = Number.parseInt(String(quiz?.questionCount || activeCount || 0), 10);
        const mismatch = Number.isFinite(expected) && expected > 0 && expected !== activeCount;
        if (mismatchEl) {
            mismatchEl.classList.toggle('d-none', !mismatch);
            mismatchEl.textContent = mismatch
                ? `Mismatch: exam expects ${expected} active questions but template currently maps ${activeCount}.`
                : '';
        }

        if (saveBtn) {
            saveBtn.disabled = mismatch;
        }
    }

    async deleteAnswerKey(quizId) {
        try {
            await this.apiCallWithAuth(`/api/quizzes/${quizId}/answer-key`, {
                method: 'DELETE'
            }, 'deleteAnswerKey');
            toastManager.showSuccess('Answer key deleted successfully.');
            return true;
        } catch (error) {
            console.error('Error deleting answer key:', error);
            return false;
        }
    }

    exportAnswerKeyJson() {
        const quiz = scanCheckConfig.currentQuiz;
        if (!quiz) return;
        const payload = this.collectAnswerKeyAnswers();
        const fileData = {
            quizId: quiz.id,
            quizTitle: quiz.title,
            questionCount: Number(quiz.questionCount || payload.activeQuestions.length || 0),
            activeQuestions: payload.activeQuestions,
            answers: payload.answers,
            generatedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(fileData, null, 2)], { type: 'application/json' });
        const fileName = `answer-key-${String(quiz.id)}.json`;
        const url = URL.createObjectURL(blob);
        try {
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            this.showToast('Answer key exported.', 'success');
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async importAnswerKeyFromFile(file) {
        if (!file) return;
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch (_error) {
            this.showToast('Import failed: invalid JSON file.', 'danger');
            return;
        }

        const answers = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.answers) ? parsed.answers : []);
        if (!answers.length) {
            this.showToast('Import file has no answers.', 'warning');
            return;
        }

        const activeQuestions = this.getAnswerKeyActiveQuestionIndexes();
        const options = Array.isArray(this.answerKeyOptionSet) && this.answerKeyOptionSet.length > 0
            ? this.answerKeyOptionSet
            : ['A', 'B', 'C', 'D'];
        let applied = 0;
        
        this.syncAnswerKeyDOMToDraft();
        activeQuestions.forEach((q, idx) => {
            const value = String(answers[idx] || '').toUpperCase();
            if (options.includes(value)) {
                this.answerKeyDraftAnswers[q - 1] = value;
                applied++;
            } else {
                this.answerKeyDraftAnswers[q - 1] = '';
            }
        });
        
        this.setAnswerKeyDirty(true);
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
        this.updateAnswerKeySummary();
        this.showToast(`Imported ${applied}/${activeQuestions.length} answers.`, 'success');
    }

    handleAnswerKeyKeyboardShortcut(event) {
        if (!this.isAnswerKeyFormVisible()) return false;
        const activeElement = document.activeElement;
        if (activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName) && !activeElement.closest('#answerKeyInputs')) {
            return false;
        }

        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        if ((!isMac && event.ctrlKey && (event.key || '').toLowerCase() === 's') || (isMac && event.metaKey && (event.key || '').toLowerCase() === 's')) {
            event.preventDefault();
            saveAnswerKey();
            return true;
        }

        const options = Array.isArray(this.answerKeyOptionSet) && this.answerKeyOptionSet.length > 0
            ? this.answerKeyOptionSet
            : ['A', 'B', 'C', 'D'];
        const keyUpper = String(event.key || '').toUpperCase();
        const keyNum = Number.parseInt(String(event.key || ''), 10);
        const focusedQuestion = Number.parseInt(String(this.answerKeyFocusQuestion || 0), 10);
        const activeQuestions = this.getAnswerKeyActiveQuestionIndexes();
        if (!activeQuestions.length) return false;
        const currentQuestion = Number.isFinite(focusedQuestion) && focusedQuestion > 0 ? focusedQuestion : activeQuestions[0];

        if (options.includes(keyUpper)) {
            event.preventDefault();
            this.setAnswerKeyAnswer(currentQuestion, keyUpper, { render: true });
            this.setAnswerKeyFocus(currentQuestion);
            return true;
        }

        if (Number.isFinite(keyNum) && keyNum >= 1 && keyNum <= options.length) {
            event.preventDefault();
            const mapped = options[keyNum - 1];
            this.setAnswerKeyAnswer(currentQuestion, mapped, { render: true });
            this.setAnswerKeyFocus(currentQuestion);
            return true;
        }

        if (event.key === 'Backspace' || event.key === 'Delete' || event.key === '0') {
            event.preventDefault();
            this.setAnswerKeyAnswer(currentQuestion, '', { render: true });
            this.setAnswerKeyFocus(currentQuestion);
            return true;
        }

        const indexInActive = activeQuestions.indexOf(currentQuestion);
        if (indexInActive === -1) return false;

        if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'Enter') {
            event.preventDefault();
            const next = activeQuestions[Math.min(activeQuestions.length - 1, indexInActive + 1)];
            this.setAnswerKeyFocus(next, { scrollIntoView: true });
            return true;
        }

        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            const prev = activeQuestions[Math.max(0, indexInActive - 1)];
            this.setAnswerKeyFocus(prev, { scrollIntoView: true });
            return true;
        }

        return false;
    }

    bindAnswerKeyEvents() {
        const container = document.getElementById('answerKeySubjectContent');
        if (!container) return;

        container.onchange = (event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.type === 'radio' && /^qd+$/.test(String(target.name || ''))) {
                const qNum = Number.parseInt(String(target.name || '').replace(/^q/, ''), 10);
                if (Number.isFinite(qNum) && qNum > 0) {
                    this.answerKeyFocusQuestion = qNum;
                }
                this.syncAnswerKeyDOMToDraft();
                this.setAnswerKeyDirty(true);
                this.renderAnswerKeyTabs();
                this.updateAnswerKeySummary();
            }
        };

        container.onclick = (event) => {
            const target = event.target;
            const box = target instanceof Element ? target.closest('.answer-key-question') : null;
            if (!box) return;
            const qNum = Number.parseInt(String(box.getAttribute('data-question') || ''), 10);
            if (Number.isFinite(qNum) && qNum > 0) {
                this.setAnswerKeyFocus(qNum);
            }
        };

        const importInput = document.getElementById('answerKeyImportInput');
        if (importInput) {
            importInput.onchange = async (event) => {
                const file = event.target?.files?.[0];
                await this.importAnswerKeyFromFile(file);
                event.target.value = '';
            };
        }
    }

    syncAnswerKeyDOMToDraft() {
        if (!this.answerKeyActiveSubject || !this.answerKeyPlan || !this.answerKeyDraftAnswers) return;
        const section = this.answerKeyPlan.sections.find(s => s.code === this.answerKeyActiveSubject);
        if (!section) return;

        for (let i = 0; i < section.count; i++) {
            const globalIndex = section.startIndex + i - 1;
            const qNum = globalIndex + 1;
            const radio = document.querySelector(`#answerKeySubjectContent input[name="q${qNum}"]:checked`);
            if (radio) {
                this.answerKeyDraftAnswers[globalIndex] = radio.value;
            } else {
                // Determine if it was unselected by DOM clearing or similar
                // We assume if it's not checked, we should update the draft appropriately (unless we haven't rendered it)
                const groupExists = document.querySelector(`#answerKeySubjectContent input[name="q${qNum}"]`);
                if (groupExists) {
                    this.answerKeyDraftAnswers[globalIndex] = '';
                }
            }
        }
    }

    cancelAnswerKeyEdit() {
        if (this.selectedAnswerKeyQuizId) {
            this.showAnswerKeyPreview(this.selectedAnswerKeyQuizId);
        } else {
            this.openCreateAnswerKey();
        }
    }

    renderAnswerKeyTabs() {
        const sections = this.answerKeyPlan.sections;
        const options = this.answerKeyOptionSet || ['A', 'B', 'C', 'D'];
        const activeFilter = this.answerKeyFilter || 'all';

        // Build tab nav using custom classes as per previous design
        let tabHtml = '<div class="answer-key-subject-nav p-3 border-bottom">';
        sections.forEach(sec => {
            const isActive = this.answerKeyActiveSubject === sec.code;
            const answered = this.answerKeyDraftAnswers.slice(sec.startIndex - 1, sec.startIndex - 1 + sec.count).filter(a => a).length;
            const isDone = answered === sec.count;
            tabHtml += `
                <button type="button" class="answer-key-subject-tab ${isActive ? 'active' : ''}" onclick="app.switchAnswerKeySubjectTab('${escapeHtml(sec.code)}')">
                    ${escapeHtml(sec.name)}
                    <span class="badge rounded-pill ${isDone ? 'bg-success' : (answered > 0 ? 'bg-warning text-dark' : 'bg-secondary')}">${answered}/${sec.count}</span>
                </button>
            `;
        });
        tabHtml += `
            <div class="ms-auto d-flex gap-2">
                <button class="btn btn-outline-primary btn-xs" onclick="app.exportAnswerKeyJson()" title="Export JSON"><i class="fas fa-file-export"></i></button>
                <button class="btn btn-outline-secondary btn-xs" onclick="document.getElementById('answerKeyImportInput').click()" title="Import JSON"><i class="fas fa-file-import"></i></button>
                <input type="file" id="answerKeyImportInput" class="d-none" accept="application/json,.json">
            </div>
        </div>`;

        let container = document.getElementById('akTabContent');
        if (!container) return;

        // Build tools bar
        const section = sections.find(s => s.code === this.answerKeyActiveSubject);
        const subjectCode = section ? escapeHtml(section.code) : '';
        let toolsHtml = `
            <div class="d-flex flex-wrap align-items-center gap-3 mb-4 bg-light p-3 rounded-3 border border-dashed">
                <div class="d-flex align-items-center gap-2">
                    <span class="small fw-bold text-muted text-uppercase">Quick Fill:</span>
                    <div class="btn-group btn-group-sm shadow-sm">
                        ${options.map(opt => `<button type="button" class="btn btn-white fw-bold px-3" onclick="app.fillAnswerKeySubject('${subjectCode}','${opt}')">${opt}</button>`).join('')}
                    </div>
                </div>
                <div class="vr mx-1 opacity-10"></div>
                <div class="d-flex align-items-center gap-2">
                    <button type="button" class="btn btn-outline-warning btn-sm" onclick="app.randomizeAnswerKeySubject('${subjectCode}')" title="Randomize subject"><i class="fas fa-random me-1"></i> Random</button>
                    <button type="button" class="btn btn-outline-danger btn-sm" onclick="app.clearAnswerKeySubject('${subjectCode}')" title="Clear subject"><i class="fas fa-eraser me-1"></i> Clear</button>
                </div>
                <div class="ms-auto d-flex align-items-center gap-2">
                    <div class="btn-group btn-group-sm shadow-sm">
                        <button class="btn ${activeFilter === 'all' ? 'btn-primary' : 'btn-white'}" onclick="app.setAnswerKeyFilter('all')">All</button>
                        <button class="btn ${activeFilter === 'blank' ? 'btn-warning text-dark' : 'btn-white'}" onclick="app.setAnswerKeyFilter('blank')">Blank</button>
                        <button class="btn ${activeFilter === 'answered' ? 'btn-success' : 'btn-white'}" onclick="app.setAnswerKeyFilter('answered')">Answered</button>
                    </div>
                </div>
            </div>
            <div id="answerKeySubjectContent"></div>
        `;

        // Update the top navigation area (akSubjectTabs)
        const navContainer = document.getElementById('akSubjectTabs');
        if (navContainer) {
            navContainer.innerHTML = tabHtml;
            // Since we use nav-tabs in index.html, we should actually put it there
            // But if we want to revert, we should use the structure the user liked.
        }

        container.innerHTML = toolsHtml;
    }

    switchAnswerKeySubjectTab(subjectCode) {
        this.syncAnswerKeyDOMToDraft();
        this.answerKeyActiveSubject = subjectCode;
        this.answerKeyFilter = 'all';
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
    }

    setAnswerKeyFilter(filter) {
        this.answerKeyFilter = filter;
        this.renderAnswerKeyTabs();
        this.renderAnswerKeyActiveSubject();
    }

    renderAnswerKeyActiveSubject() {
        const section = this.answerKeyPlan.sections.find(s => s.code === this.answerKeyActiveSubject);
        if (!section) return;

        const options = this.answerKeyOptionSet;
        const activeFilter = this.answerKeyFilter || 'all';

        let html = `<div class="card border-0 shadow-sm"><div class="card-body p-4"><div class="row row-cols-1 row-cols-md-2 row-cols-lg-3 row-cols-xl-4 g-3">`;

        let renderedCount = 0;
        for (let i = 0; i < section.count; i++) {
            const globalIndex = section.startIndex + i - 1;
            const qNum = globalIndex + 1;
            const currentAns = this.answerKeyDraftAnswers[globalIndex] || '';
            const isBlank = !currentAns;

            if (activeFilter === 'blank' && !isBlank) continue;
            if (activeFilter === 'answered' && isBlank) continue;

            renderedCount++;
            html += `
                <div class="col">
                    <div class="answer-key-question-card h-100 p-2 border rounded-3 d-flex align-items-center justify-content-between ${isBlank ? 'bg-light bg-opacity-50 border-warning border-opacity-25' : 'bg-white shadow-sm'}" 
                         data-active="1" data-subject="${escapeHtml(section.code)}" data-question="${qNum}">
                        <div class="fw-bold text-muted small me-2" style="min-width: 30px;">Q${qNum}</div>
                        <div class="answer-key-segmented-btns flex-grow-1">
                            ${options.map(opt => `
                                <input type="radio" class="btn-check" name="q${qNum}" id="q${qNum}_${opt}" value="${opt}" ${currentAns === opt ? 'checked' : ''} autocomplete="off">
                                <label class="btn btn-sm px-2" for="q${qNum}_${opt}">${opt}</label>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
        }

        if (renderedCount === 0) {
            html = `<div class="card border-0 shadow-sm"><div class="card-body p-5 text-center">
                <i class="fas fa-filter d-block mb-3 opacity-25" style="font-size: 3rem;"></i>
                <div class="text-muted">No questions match filter "${activeFilter}".</div>
            </div>`;
        } else {
            html += `</div></div></div>`;
        }

        const contentEl = document.getElementById('answerKeySubjectContent');
        if (contentEl) contentEl.innerHTML = html;
        this.bindAnswerKeyEvents();
    }

    showAnswerKeyForm(quiz) {
        scanCheckConfig.currentQuiz = quiz;
        this.answerKeyQuizId = String(quiz.id);
        this.selectedAnswerKeyQuizId = String(quiz.id);
        
        // Hide other panels
        document.getElementById('akEmptyState')?.classList.add('d-none');
        document.getElementById('answerKeyPreview')?.classList.add('d-none');
        
        // Show edit panel
        const editPanel = document.getElementById('answerKeyEdit');
        if (editPanel) editPanel.classList.remove('d-none');
        
        const titleEl = document.getElementById('akEditTitle');
        if (titleEl) titleEl.textContent = quiz.title;

        const container = document.getElementById('akTabContent');
        const optCount = Math.min(6, Math.max(1, Number(quiz.options) || 4));
        const options = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, optCount);
        const answerPlan = this.buildAnswerKeySubjectPlan(quiz.questionCount, this.getSubjectConfigForQuiz(quiz), quiz.format);
        
        this.answerKeyPlan = answerPlan;
        this.answerKeyOptionSet = options;
        this.answerKeyFocusQuestion = null;
        this.answerKeyLastSavedAt = '';
        this.setAnswerKeyDirty(false);
        this.answerKeyDraftAnswers = new Array(answerPlan.totalQuestions).fill('');
        
        // Fix typo if it exists in answerPlan (GENERAL INFORMATION)
        answerPlan.sections.forEach(s => {
            if (s.name.includes("GENRAL")) s.name = s.name.replace("GENRAL", "GENERAL");
        });

        this.answerKeyActiveSubject = answerPlan.sections[0].code;
        this.answerKeyFilter = 'all';

        this.loadAnswerKey(quiz.id).then((existingAnswers) => {
            if (Array.isArray(existingAnswers)) {
                existingAnswers.slice(0, answerPlan.totalQuestions).forEach((ans, idx) => {
                    const val = String(ans || '').toUpperCase();
                    if (options.includes(val)) {
                        this.answerKeyDraftAnswers[idx] = val;
                    }
                });
            }
            container.innerHTML = '';
            this.renderAnswerKeyTabs();
            this.renderAnswerKeyActiveSubject();
            this.updateAnswerKeySummary();
        });
    }

    async handleAnswerKeySave() {
        const quiz = scanCheckConfig.currentQuiz;
        if (!quiz) {
            alert('No exam selected');
            return;
        }

        const payload = this.collectAnswerKeyAnswers();
        const emptyAnswers = payload.answers.filter((a) => !a);
        if (emptyAnswers.length > 0) {
            const continueSave = confirm(`You have ${emptyAnswers.length} unanswered active questions. Save anyway?`);
            if (!continueSave) return;
        }

        const success = await this.saveAnswerKey(quiz.id, payload.answers);
        if (!success) return;

        this.setAnswerKeyDirty(false);
        this.answerKeyLastSavedAt = new Date().toISOString();
        await this.refreshAnswerKeyCatalog();
        this.selectedAnswerKeyQuizId = String(quiz.id);
        this.renderAnswerKeyList();
        await this.showAnswerKeyPreview(quiz.id);
        localStorage.setItem('scancheck_selected_scanner_quiz', quiz.id);
    }

    async handleAnswerKeyDelete() {
        const quiz = scanCheckConfig.currentQuiz;
        if (!quiz) {
            alert('No exam selected');
            return;
        }
        if (!confirm(`Delete answer key for "${quiz.title}"?`)) return;

        const success = await this.deleteAnswerKey(quiz.id);
        if (!success) return;

        if (this.isAnswerKeyFormVisible()) {
            this.clearAnswerKeyAll();
        }
        this.setAnswerKeyDirty(false);
        this.selectedAnswerKeyQuizId = null;
        await this.refreshAnswerKeyCatalog();
        this.renderAnswerKeyList();
        this.openCreateAnswerKey();
    }

    async handleQuizFormSubmit() {
        const form = document.getElementById('createQuizForm');
        const formData = new FormData(form);
        const quizId = formData.get('quizId');
        const existingQuiz = quizId ? this.quizzes.find((q) => String(q.id) === String(quizId)) : null;
        const format = formData.get('type') || 'multi-subject';
        const subjectConfig = (format === 'normal') ? [] : quizId
            ? this.getSubjectConfigForQuiz(existingQuiz || quizId)
            : this.getSavedMultiSubjects();

        const rawQuizData = {
            title: formData.get('title'),
            questionCount: parseInt(formData.get('questionCount'), 10),
            options: parseInt(formData.get('options') || '4', 10) || 4,
            passingScore: parseInt(formData.get('passingScore') || PASSING_SCORE, 10) || PASSING_SCORE,
            format,
            subjectConfig
        };
        const quizData = this.normalizeQuizData(rawQuizData);
        if (quizData.questionCount > 100) {
            this.showToast('Question count cannot exceed 100.', 'warning');
            return;
        }

        if (quizId) {
            // Update existing quiz
            await this.updateQuiz(quizId, quizData);
        } else {
            // Create new quiz
            await this.createQuiz(quizData);
        }

        this.resetQuizForm();
    }

    async createQuiz(quizData) {
        quizData = this.normalizeQuizData(quizData);
        if (!quizData.createdAt) {
            quizData.createdAt = new Date().toISOString();
        }

        try {
            const newQuiz = await this.apiCallWithAuth('/api/quizzes', {
                method: 'POST',
                body: JSON.stringify(quizData)
            }, 'createQuiz');
            const normalizedNewQuiz = this.normalizeQuizData(newQuiz);
            this.quizzes.unshift(normalizedNewQuiz);
            this.saveLocalQuiz(normalizedNewQuiz);
            this.renderQuizList();
            
            // Generate answer sheet for the new quiz
            scanCheckConfig.currentQuiz = normalizedNewQuiz;
            if (normalizedNewQuiz.format === 'normal' && window.normalAnswerSheetGenerator) {
                window.normalAnswerSheetGenerator.generate(normalizedNewQuiz);
            } else if (window.answerSheetGenerator) {
                window.answerSheetGenerator.generate(normalizedNewQuiz);
            }
            
            toastManager.showSuccess('Quiz created successfully!');
        } catch (error) {
            // Fallback to local storage
            quizData.id = 'quiz_' + Date.now();
            this.quizzes.unshift(quizData);
            this.saveLocalQuiz(quizData);
            this.renderQuizList();
            
            scanCheckConfig.currentQuiz = quizData;
            if (quizData.format === 'normal' && window.normalAnswerSheetGenerator) {
                window.normalAnswerSheetGenerator.generate(quizData);
            } else if (window.answerSheetGenerator) {
                window.answerSheetGenerator.generate(quizData);
            }
            
            toastManager.showInfo('Quiz created in local fallback mode');
        }
    }

    async updateQuiz(quizId, quizData) {
        quizData = this.normalizeQuizData(quizData);
        try {
            const updatedQuiz = await this.apiCallWithAuth(`/api/quizzes/${quizId}`, {
                method: 'PUT',
                body: JSON.stringify(quizData)
            }, 'updateQuiz');
            const normalizedUpdatedQuiz = this.normalizeQuizData(updatedQuiz);
            
            const index = this.quizzes.findIndex(q => q.id == quizId);
            if (index !== -1) {
                this.quizzes[index] = normalizedUpdatedQuiz;
                this.updateLocalQuiz(normalizedUpdatedQuiz);
            }
            
            this.renderQuizList();
            toastManager.showSuccess('Quiz updated successfully');
        } catch (error) {
            // Fallback to local storage update
            const index = this.quizzes.findIndex(q => q.id == quizId);
            if (index !== -1) {
                this.quizzes[index] = { ...this.quizzes[index], ...quizData };
                this.updateLocalQuiz(this.quizzes[index]);
                this.renderQuizList();
                toastManager.showInfo('Quiz updated in local fallback mode');
            } else {
                // Error already handled by apiCallWithAuth
            }
        }
    }

    async deleteQuiz(quizId) {
        // If there's already a pending deletion for this ID, ignore
        if (this.pendingDeletions.has(quizId)) return;

        // Store the original quiz data and its position
        const quizIndex = this.quizzes.findIndex(q => q.id == quizId);
        if (quizIndex === -1) return;
        
        const quizData = this.quizzes[quizIndex];

        // Remove from current view
        this.quizzes.splice(quizIndex, 1);
        this.renderQuizList();
        
        if (scanCheckConfig.currentQuiz && scanCheckConfig.currentQuiz.id == quizId) {
            scanCheckConfig.currentQuiz = null;
            const prev = document.getElementById('answerSheetPreview');
            if (prev) prev.innerHTML = '<div id="omr-sheet"></div>';
        }

        // Set a timeout for actual archiving
        const timeoutId = setTimeout(async () => {
            try {
                const result = await this.apiCallWithAuth(`/api/quizzes/${quizId}`, {
                    method: 'DELETE'
                }, 'deleteQuiz');
                this.deleteLocalQuiz(quizId);
                this.pendingDeletions.delete(quizId);
                toastManager.showSuccess('Quiz archived. Student data preserved.');
                // Refresh archived count badge
                this.loadQuizzes();
            } catch (error) {
                console.error('Final archiving failed:', error);
                this.deleteLocalQuiz(quizId);
                this.pendingDeletions.delete(quizId);
            }
        }, 5000);

        // Track the pending deletion
        this.pendingDeletions.set(quizId, {
            timeoutId,
            quizData,
            quizIndex
        });

        // Show toast with Undo button
        this.showToast(`Quiz "${quizData.title}" archived — student data preserved`, 'warning', {
            label: 'UNDO',
            callback: () => {
                const pending = this.pendingDeletions.get(quizId);
                if (pending) {
                    clearTimeout(pending.timeoutId);
                    this.quizzes.splice(pending.quizIndex, 0, pending.quizData);
                    this.renderQuizList();
                    this.pendingDeletions.delete(quizId);
                    this.showToast('Restored quiz', 'success');
                }
            }
        });
    }

    // Load archived (soft-deleted) quizzes
    async loadArchivedQuizzes() {
        try {
            return await this.apiCallWithAuth('/api/quizzes?archived=1', {}, 'loadArchivedQuizzes');
        } catch (error) {
            console.error('Error loading archived quizzes:', error);
            return [];
        }
    }

    // Restore an archived quiz
    async restoreQuiz(quizId) {
        try {
            await this.apiCallWithAuth(`/api/quizzes/${quizId}/restore`, {
                method: 'POST'
            }, 'restoreQuiz');
            toastManager.showSuccess('Quiz restored successfully!');
            // Refresh both lists
            await this.loadQuizzes();
            if (this._showArchivedQuizzes) {
                await this.renderArchivedQuizzes();
            }
        } catch (error) {
            console.error('Error restoring quiz:', error);
            toastManager.showError('Failed to restore quiz');
        }
    }

    // Permanently delete an archived quiz (irreversible)
    async permanentDeleteQuiz(quizId) {
        if (!confirm('Permanently delete this answer key and ALL its associated scans and records? This cannot be undone.')) {
            return;
        }
        try {
            const response = await this.apiCallWithAuth(`/api/quizzes/${quizId}/permanent`, {
                method: 'DELETE'
            }, 'permanentDeleteQuiz');
            const detail = response && response.message ? ` ${response.message}` : '';
            toastManager.showSuccess(`Answer key permanently deleted.${detail}`);
            // Refresh both lists
            await this.loadQuizzes();
            if (this._showArchivedQuizzes) {
                await this.renderArchivedQuizzes();
            }
            const badge = document.getElementById('archivedCountBadge');
            if (badge) badge.textContent = '0';
        } catch (error) {
            console.error('Error deleting quiz:', error);
            toastManager.showError('Failed to delete answer key');
        }
    }

    // Render archived quizzes
    async renderArchivedQuizzes() {
        const container = document.getElementById('archivedQuizList');
        if (!container) return;
        
        container.innerHTML = '<div class="text-center py-3"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
        
        const archived = await this.loadArchivedQuizzes();
        
        if (!archived || archived.length === 0) {
            container.innerHTML = `
                <div class="text-center text-muted py-5">
                    <i class="fas fa-archive mb-3" style="font-size: 2.5rem; opacity: 0.3;"></i>
                    <p class="mb-0">No archived answer keys</p>
                    <small>Deleted answer keys will appear here and can be restored</small>
                </div>
            `;
            const badge = document.getElementById('archivedCountBadge');
            if (badge) badge.textContent = '0';
            return;
        }
        
        container.innerHTML = archived.map(quiz => `
            <div class="d-flex align-items-center justify-content-between p-3 border-bottom">
                <div>
                    <div class="fw-bold text-dark">${escapeHtml(quiz.title)}</div>
                    <div class="small text-muted">
                        ID: ${quiz.id} · ${quiz.questionCount} questions · ${quiz.format === 'normal' ? 'Single-Subject' : 'Multi-Subject'}
                    </div>
                </div>
                <div>
                    <button class="btn btn-sm btn-outline-success me-2" onclick="app.restoreQuiz(${quiz.id})" title="Restore this answer key">
                        <i class="fas fa-undo me-1"></i> Restore
                    </button>
                    <button class="btn btn-sm btn-outline-danger" onclick="app.permanentDeleteQuiz(${quiz.id})" title="Permanently delete this answer key and all its data">
                        <i class="fas fa-trash me-1"></i> Delete
                    </button>
                </div>
            </div>
        `).join('');

        // Update badge count
        const badge = document.getElementById('archivedCountBadge');
        if (badge) badge.textContent = archived.length;
    }

    editQuiz(quizId) {
        const quiz = this.quizzes.find(q => q.id == quizId);
        if (quiz) {
            this.editingQuizId = quiz.id;
            this.currentQuizType = quiz.format || 'multi-subject';
            document.querySelector('#createQuizForm input[name="quizId"]').value = quiz.id;
            document.querySelector('#createQuizForm input[name="title"]').value = quiz.title;
            document.querySelector('#createQuizForm input[name="questionCount"]').value = quiz.questionCount;
            document.querySelector('#createQuizForm input[name="passingScore"]').value = quiz.passingScore || PASSING_SCORE;
            const typeSel = document.querySelector('#createQuizForm select[name="type"]');
            if (typeSel) typeSel.value = this.currentQuizType;
            const optSel = document.querySelector('#createQuizForm select[name="options"]');
            if (optSel) optSel.value = String(Math.min(6, Math.max(4, Number(quiz.options) || 4)));
            
            this.toggleSubjectsButton();
            this.applyQuizFormFormatRules();
            
            document.getElementById('formSubmitBtn').innerHTML = '<i class="fas fa-save me-1"></i> Save Exam';
            document.getElementById('cancelUpdateBtn').classList.remove('d-none');
            
            const modalEl = document.getElementById('createExamModal');
            if (modalEl) {
                const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
                modal.show();
            }
        }
    }

    resetQuizForm() {
        const form = document.getElementById('createQuizForm');
        form.reset();
        this.editingQuizId = null;
        this.currentQuizType = 'multi-subject';
        document.querySelector('#createQuizForm input[name="quizId"]').value = '';
        this.toggleSubjectsButton();
        this.applyQuizFormFormatRules();
        document.getElementById('formSubmitBtn').innerHTML = '<i class="fas fa-save me-1"></i> Save Exam';
        document.getElementById('cancelUpdateBtn').classList.add('d-none');
        
        const modalEl = document.getElementById('createExamModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
    }

    // Local storage fallbacks
    getLocalQuizzes() {
        return JSON.parse(localStorage.getItem('scancheck_quizzes') || '[]');
    }

    saveLocalQuiz(quiz) {
        const quizzes = this.getLocalQuizzes();
        const index = quizzes.findIndex(q => q.id == quiz.id);
        if (index !== -1) {
            quizzes[index] = quiz;
        } else {
            quizzes.unshift(quiz);
        }
        localStorage.setItem('scancheck_quizzes', JSON.stringify(quizzes));
    }

    updateLocalQuiz(quiz) {
        this.saveLocalQuiz(quiz);
    }

    deleteLocalQuiz(quizId) {
        let quizzes = this.getLocalQuizzes();
        quizzes = quizzes.filter(q => q.id != quizId);
        localStorage.setItem('scancheck_quizzes', JSON.stringify(quizzes));
    }

    getLocalScanResults() {
        return JSON.parse(localStorage.getItem('scancheck_scans') || '[]');
    }

    showToast(message, type = 'info', action = null) {
        // Delegate to shared toastManager
        if (action) {
            return toastManager.showToast(message, type, { action });
        }
        return toastManager.showToast(message, type);
    }

    prepareEditSubjectsModal() {
        const savedSubjects = localStorage.getItem('scancheck_multi_subjects');
        let subjects = [];
        if (savedSubjects) {
            try {
                subjects = JSON.parse(savedSubjects);
            } catch (e) {
                console.error('Error parsing saved subjects:', e);
            }
        }

        subjects = this.normalizeMultiSubjectDefinition(subjects);
        
        this.renderSubjectsToEdit(subjects);
    }

    openEditSubjectsModal() {
        this.prepareEditSubjectsModal();
        const modal = new bootstrap.Modal(document.getElementById('editSubjectsModal'));
        modal.show();
    }

    renderSubjectsToEdit(subjects) {
        const container = document.getElementById('subjectsListContainer');
        container.innerHTML = subjects.map((s, index) => `
            <div class="subject-edit-row d-flex gap-2 mb-2 align-items-center">
                <input type="text" class="form-control form-control-sm" placeholder="Code" value="${s.code}" style="width: 90px;" onchange="app.updateSubjectsTotalCounter()">
                <input type="text" class="form-control form-control-sm" placeholder="Subject Name" value="${s.name}" onchange="app.updateSubjectsTotalCounter()">
                <input type="number" class="form-control form-control-sm" placeholder="Qs" value="${s.questions || 20}" style="width: 80px;" min="1" max="100" onchange="app.updateSubjectsTotalCounter()">
                <button class="btn btn-sm btn-outline-danger" onclick="app.removeSubjectFromEdit(this)" title="Remove Subject">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `).join('');
        this.updateSubjectsTotalCounter();
    }

    addSubjectToEdit() {
        const container = document.getElementById('subjectsListContainer');
        if (!container) return;
        container.insertAdjacentHTML('beforeend', `
            <div class="subject-edit-row d-flex gap-2 mb-2 align-items-center">
                <input type="text" class="form-control form-control-sm" placeholder="Code" style="width: 90px;" onchange="app.updateSubjectsTotalCounter()">
                <input type="text" class="form-control form-control-sm" placeholder="Subject Name" onchange="app.updateSubjectsTotalCounter()">
                <input type="number" class="form-control form-control-sm" placeholder="Qs" value="20" style="width: 80px;" min="1" max="100" onchange="app.updateSubjectsTotalCounter()">
                <button class="btn btn-sm btn-outline-danger" onclick="app.removeSubjectFromEdit(this)" title="Remove Subject">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `);
        this.updateSubjectsTotalCounter();
    }

    removeSubjectFromEdit(btn) {
        const row = btn.closest('.subject-edit-row');
        if (row) {
            row.remove();
            this.updateSubjectsTotalCounter();
        }
    }

    updateSubjectsTotalCounter() {
        const rows = document.querySelectorAll('.subject-edit-row');
        let total = 0;
        rows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            if (inputs.length >= 3) {
                total += Number.parseInt(inputs[2].value || '0', 10);
            }
        });
        const counterEl = document.getElementById('subjectTotalCounter');
        if (counterEl) {
            counterEl.textContent = `Total: ${total} questions`;
        }
        
        const warningEl = document.getElementById('subjectWarning');
        const examQsEl = document.getElementById('questionCount');
        if (warningEl && examQsEl) {
            const examQs = Number.parseInt(examQsEl.value || '100', 10);
            if (total > 0 && total !== examQs) {
                warningEl.classList.remove('d-none');
            } else {
                warningEl.classList.add('d-none');
            }
        }
    }

    saveSubjects() {
        const rows = document.querySelectorAll('.subject-edit-row');
        const subjects = [];
        rows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            const code = inputs[0].value.trim().toUpperCase();
            const name = inputs[1].value.trim().toUpperCase();
            const rawQuestions = Number.parseInt(String(inputs[2]?.value || '20'), 10);
            const questions = Number.isFinite(rawQuestions) ? Math.min(100, Math.max(1, rawQuestions)) : 20;
            
            if (code && name) {
                subjects.push({ code, name, questions });
            }
        });
        
        const normalizedSubjects = this.normalizeMultiSubjectDefinition(subjects);
        const totalQuestions = normalizedSubjects.reduce((sum, item) => sum + (Number.parseInt(String(item.questions), 10) || 0), 0);
        if (totalQuestions > 100) {
            this.showToast(`Total questions cannot exceed 100 (current: ${totalQuestions}).`, 'warning');
            return;
        }
        
        localStorage.setItem('scancheck_multi_subjects', JSON.stringify(normalizedSubjects));
        const questionCountInput = document.getElementById('questionCount');
        if (questionCountInput && totalQuestions > 0) {
            questionCountInput.value = String(totalQuestions);
        }

        this.showToast(`Subject layout saved (${totalQuestions} total questions).`, 'success');
        
        // Hide modal
        const modalEl = document.getElementById('editSubjectsModal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) modal.hide();
        
        // Re-generate current preview after subject changes.
        this.generateGenericSheet();
    }

    // Received Papers Logic
    async loadReceivedPapers() {
        try {
            const papers = await this.apiCallWithAuth('/api/received-papers', {}, 'loadReceivedPapers');
            this.receivedPapers = (papers || []).map(paper => ({
                ...paper,
                image_url: paper.image_url || scanCheckConfig.resolveAssetUrl(paper.image_path)
            }));
            this.renderReceivedPapers();
        } catch (error) {
            console.error('Error loading received papers:', error);
            this.receivedPapers = [];
            this.renderReceivedPapers();
        }
    }

    getReceivedPaperImageUrl(paper) {
        const url = paper?.image_url || scanCheckConfig.resolveAssetUrl(paper?.image_path) || '';
        if (!url) return '';

        // This backend serves uploaded images under `/api/uploads/*` (because the
        // static handler is mounted inside the `/api` router).
        // Some stored paths use `/uploads/*`, so rewrite them for the UI.
        if (url.includes('/api/uploads/')) return url;
        return url.replace('/uploads/', '/api/uploads/');
    }

    renderReceivedPapers() {
        const container = document.getElementById('receivedPapersList');
        const courseFilter = document.getElementById('receivedPapersCourseFilter');
        const statusFilter = document.getElementById('receivedPapersStatusFilter');
        const totalCountEl = document.getElementById('totalReceivedCount');
        if (!container) return;

        if (totalCountEl) totalCountEl.textContent = this.receivedPapers.length;

        const previousCourseFilter = courseFilter ? courseFilter.value : '';
        const previousStatusFilter = statusFilter ? statusFilter.value : '';

        if (courseFilter) {
            const currentCourses = [...new Set(this.receivedPapers.map(paper => paper.course || 'Unassigned Course'))].sort();
            const existingOptions = Array.from(courseFilter.options).map(opt => opt.value).filter(val => val !== "");
            
            // Only re-populate if the courses list actually changed
            if (JSON.stringify(currentCourses) !== JSON.stringify(existingOptions)) {
                courseFilter.innerHTML = '<option value="">All Courses</option>';
                currentCourses.forEach(course => {
                    const option = document.createElement('option');
                    option.value = course;
                    option.textContent = course;
                    courseFilter.appendChild(option);
                });
                courseFilter.value = previousCourseFilter;
            }
        }

        let filtered = this.receivedPapers;
        if (previousCourseFilter) {
            filtered = filtered.filter(paper => (paper.course || 'Unassigned Course') === previousCourseFilter);
        }
        
        if (previousStatusFilter) {
            console.log(`Filtering by status: ${previousStatusFilter}`);
            if (previousStatusFilter === 'scanned') {
                filtered = filtered.filter(paper => {
                    const isScanned = paper.is_scanned === 1 || paper.is_scanned === true || paper.is_scanned === '1';
                    return isScanned;
                });
            } else if (previousStatusFilter === 'pending') {
                filtered = filtered.filter(paper => {
                    const isScanned = paper.is_scanned === 1 || paper.is_scanned === true || paper.is_scanned === '1';
                    return !isScanned;
                });
            }
        }

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox empty-state-icon"></i>
                    <h6 class="empty-state-title">Inbox is empty</h6>
                    <p class="empty-state-description small">No mobile papers found matching your filters.</p>
                </div>
            `;
            this.clearReceivedPaperPreview();
            return;
        }

        container.innerHTML = filtered.map(paper => {
            const paperCode = paper.sheet_id || paper.image_file_name || `Paper #${paper.id}`;
            const isActive = Number(paper.id) === Number(this.selectedReceivedPaperId);
            const isSelected = this.selectedInboxPaperIds.has(Number(paper.id));
            const isScanned = paper.is_scanned === 1 || paper.is_scanned === true || paper.is_scanned === '1';
            
            return `
            <div class="list-group-item list-group-item-action border-0 px-3 py-2 mb-1 rounded-0 d-flex align-items-center gap-2 ${isActive ? 'active shadow-sm' : ''} ${isScanned && !isActive ? 'bg-light opacity-75' : ''}"
               id="received-paper-${paper.id}" style="cursor: pointer;">
                <div class="form-check mb-0">
                    <input class="form-check-input inbox-checkbox" type="checkbox" value="${paper.id}" 
                           ${isSelected ? 'checked' : ''} 
                           onclick="event.stopPropagation(); app.toggleInboxPaperSelection(${paper.id}, this.checked)">
                </div>
                <div class="d-flex align-items-center flex-grow-1 overflow-hidden" onclick="app.selectReceivedPaper(${paper.id})">
                    <div class="bg-${isActive ? 'white' : (isScanned ? 'success' : 'light')} bg-opacity-${isActive ? '25' : (isScanned ? '10' : '100')} rounded-circle d-flex align-items-center justify-content-center me-3" style="width: 36px; height: 36px; flex-shrink: 0;">
                        <i class="fas ${isScanned ? 'fa-check' : 'fa-file-image'} ${isActive ? 'text-white' : (isScanned ? 'text-success' : 'text-primary')}"></i>
                    </div>
                    <div class="text-truncate me-auto">
                        <div class="fw-bold small text-truncate ${isActive ? 'text-white' : (isScanned ? 'text-muted' : 'text-dark')}">
                            ${escapeHtml(paper.student_name || 'Untitled Paper')}
                            ${isScanned ? '<span class="ms-1 badge bg-success bg-opacity-10 text-success fw-normal border border-success border-opacity-25" style="font-size: 0.6rem;">SCANNED</span>' : ''}
                        </div>
                        <div class="x-small ${isActive ? 'text-white opacity-75' : 'text-muted'}">${escapeHtml(paper.course || 'Unassigned Course')}</div>
                    </div>
                    <div class="text-end ms-2" style="min-width: 60px;">
                        <div class="x-small ${isActive ? 'text-white opacity-75' : 'text-muted'}">${new Date(paper.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                        <div class="x-small fw-bold ${isActive ? 'text-white' : 'text-muted'}">#${escapeHtml(paper.id)}</div>
                    </div>
                </div>
            </div>
            `;
        }).join('');

        this.updateInboxSelectionUI();
        this.renderConnectedDevices();
    }

    toggleInboxPaperSelection(id, isSelected) {
        const paperId = Number(id);
        if (isSelected) {
            if (this.selectedInboxPaperIds.size >= 50) {
                this.showToast('Selection limit reached (max 50 papers).', 'warning');
                this.renderReceivedPapers();
                return;
            }
            this.selectedInboxPaperIds.add(paperId);
        } else {
            this.selectedInboxPaperIds.delete(paperId);
        }
        this.updateInboxSelectionUI();
    }

    toggleAllReceivedPapers(isSelected) {
        if (isSelected) {
            const papers = this.receivedPapers.slice(0, 50);
            this.selectedInboxPaperIds = new Set(papers.map(p => Number(p.id)));
            if (this.receivedPapers.length > 50) {
                this.showToast('Selected the first 50 papers (max limit).', 'info');
            }
        } else {
            this.selectedInboxPaperIds.clear();
        }
        this.renderReceivedPapers();
    }

    updateInboxSelectionUI() {
        const count = this.selectedInboxPaperIds.size;
        const countSpan = document.getElementById('inboxSelectedCount');
        const selectAllCheckbox = document.getElementById('receivedPapersSelectAll');
        const footerScanBtnText = document.getElementById('scanReceivedPaperBtnText');
        const footerActions = document.getElementById('receivedPaperActions');
        const selectionSummary = document.getElementById('selectionSummary');
        const removeBtn = document.getElementById('removeReceivedPaperBtn');

        if (countSpan) countSpan.textContent = count;
        
        // Always show footer actions if something is selected OR a paper is being previewed
        if (footerActions) {
            if (count > 0 || this.selectedReceivedPaperId) {
                footerActions.classList.remove('d-none');
            } else {
                footerActions.classList.add('d-none');
            }
        }

        if (selectionSummary) {
            if (count > 0) {
                selectionSummary.classList.remove('d-none');
            } else {
                selectionSummary.classList.add('d-none');
            }
        }

        if (footerScanBtnText) {
            if (count > 1) {
                footerScanBtnText.textContent = `Bulk Scan (${count})`;
            } else {
                footerScanBtnText.textContent = 'Scan Now';
            }
        }

        // Disable remove button if multiple items are selected (only single removal supported via preview)
        if (removeBtn) {
            removeBtn.disabled = count > 1;
            removeBtn.classList.toggle('opacity-50', count > 1);
        }
        
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = count > 0 && count === Math.min(this.receivedPapers.length, 50);
        }
    }

    handleDynamicScanClick() {
        const count = this.selectedInboxPaperIds.size;
        if (count > 1) {
            this.bulkScanFromInbox();
        } else if (count === 1) {
            const paperId = Array.from(this.selectedInboxPaperIds)[0];
            this.processPaper(paperId);
        } else if (this.selectedReceivedPaperId) {
            this.processPaper(this.selectedReceivedPaperId);
        } else {
            this.showToast('Please select a paper to scan.', 'warning');
        }
    }

    async bulkScanFromInbox() {
        if (this.selectedInboxPaperIds.size === 0) return;

        const papersToScan = this.receivedPapers.filter(p => this.selectedInboxPaperIds.has(Number(p.id)));
        
        // Prepare images for Scan Workspace
        const images = papersToScan.map(p => ({
            id: p.id,
            name: p.student_name || `Paper #${p.id}`,
            dataUrl: this.getReceivedPaperImageUrl(p),
            status: 'ready',
            sourceReceivedPaperId: p.id
        }));

        // Switch to Scan Workspace
        this.selectedScanImages = images;
        this.selectedScanImage = images[0]?.dataUrl;
        this.selectedReceivedPaperId = images[0]?.id;
        
        // Go to Scan Workspace
        window.location.hash = '#/scan';
        
        // Render and notify
        this.renderBulkScanQueue();
        this.updateScannerScanButtonState();
        this.showToast(`Transferred ${images.length} papers to workspace. Ready for bulk scanning.`, 'success');
        
        // Clear inbox selection and refresh to show "SCANNED" if some were already scanned
        this.selectedInboxPaperIds.clear();
        this.renderReceivedPapers();
    }

    async processPaper(paperId) {
        const paper = this.receivedPapers.find(p => Number(p.id) === Number(paperId));
        if (!paper) return;

        this.selectedReceivedPaperId = paper.id;
        this.selectedScanImage = this.getReceivedPaperImageUrl(paper);
        
        // Clear bulk queue and set single image
        this.selectedScanImages = [{
            id: paper.id,
            name: paper.student_name || `Paper #${paper.id}`,
            dataUrl: this.selectedScanImage,
            status: 'ready',
            sourceReceivedPaperId: paper.id
        }];
        
        window.location.hash = '#/scan';
        this.setScannerPreviewImage(this.selectedScanImage, paper.student_name);
        this.renderBulkScanQueue();
        this.updateScannerScanButtonState();
        
        // Pre-fill scanner metadata if available
        setTimeout(() => {
            if (document.getElementById('scannerStudentName')) document.getElementById('scannerStudentName').value = paper.student_name || '';
            if (document.getElementById('scannerEntryType')) document.getElementById('scannerEntryType').value = paper.entry_type || '';
            if (document.getElementById('scannerEquityGroup')) document.getElementById('scannerEquityGroup').value = paper.equity_group || 'None';
        }, 500);
    }

    renderConnectedDevices() {
        const container = document.getElementById('connectedDevicesList');
        if (!container) return;

        // Group received papers by sender IP and device ID
        const devices = new Map();
        
        this.receivedPapers.forEach(paper => {
            const ip = paper.sender_ip || 'Unknown IP';
            const deviceId = paper.device_id || 'Unknown Device';
            const key = `${ip}-${deviceId}`;
            
            if (!devices.has(key)) {
                devices.set(key, {
                    ip: ip,
                    id: deviceId,
                    count: 0,
                    lastActivity: new Date(0),
                    status: 'Active'
                });
            }
            
            const device = devices.get(key);
            device.count++;
            const activity = new Date(paper.timestamp);
            if (activity > device.lastActivity) {
                device.lastActivity = activity;
            }
        });

        if (devices.size === 0) {
            container.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center py-5">
                        <div class="text-muted">
                            <i class="fas fa-mobile-alt fa-3x mb-3 opacity-25"></i>
                            <p>No active mobile connections detected yet.</p>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        container.innerHTML = Array.from(devices.values()).map(device => {
            const timeAgo = this.formatTimeAgo(device.lastActivity);
            const isRecent = (new Date() - device.lastActivity) < 300000; // 5 mins
            
            return `
                <tr>
                    <td class="ps-4">
                        <div class="d-flex align-items-center gap-2">
                            <i class="fas fa-mobile-alt text-muted"></i>
                            <code class="text-primary fw-bold">${escapeHtml(device.ip)}</code>
                        </div>
                    </td>
                    <td>
                        <div class="fw-bold text-dark">${escapeHtml(device.id)}</div>
                        <div class="x-small text-muted">Device Identifier</div>
                    </td>
                    <td>
                        <span class="badge bg-light text-dark border fw-normal">
                            <i class="fas fa-file-upload me-1 text-primary"></i> ${device.count} Papers Sent
                        </span>
                    </td>
                    <td>
                        <div class="small text-muted">
                            <i class="far fa-clock me-1"></i> ${timeAgo}
                        </div>
                    </td>
                    <td class="text-end pe-4">
                        <span class="badge bg-${isRecent ? 'success' : 'secondary'} bg-opacity-10 text-${isRecent ? 'success' : 'secondary'} border border-${isRecent ? 'success' : 'secondary'} border-opacity-25 rounded-pill px-3">
                            <i class="fas fa-circle me-1 small"></i> ${isRecent ? 'Online' : 'Offline'}
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        return date.toLocaleDateString();
    }

    selectReceivedPaper(id) {
        const paper = this.receivedPapers.find(item => item.id === id);
        if (!paper) return;
        const imageUrl = this.getReceivedPaperImageUrl(paper);

        this.selectedReceivedPaperId = id;
        this.renderReceivedPapers();

        const preview = document.getElementById('receivedPaperPreview');
        if (preview) {
            const paperCode = paper.sheet_id || paper.image_file_name || `Paper #${paper.id}`;
            preview.innerHTML = `
                <img src="${imageUrl}" class="img-fluid rounded shadow" alt="Paper Preview" style="max-height: 450px;"
                     onerror="if(!this.dataset.fallbackTried){this.dataset.fallbackTried='1';this.src=this.src.includes('/api/uploads/')?this.src.replace('/api/uploads/','/uploads/'):this.src.replace('/uploads/','/api/uploads/');}else{this.style.display='none';}">
                <div class="mt-3 text-start w-100 px-4">
                    <h5 class="fw-bold mb-1">${escapeHtml(paper.student_name || 'Untitled Paper')}</h5>
                    <p class="mb-1 text-muted small">Sheet: ${escapeHtml(paperCode)}</p>
                    <p class="mb-0 text-muted">
                        ${escapeHtml(paper.course || 'Unassigned Course')} 
                        ${paper.age ? `| Age: ${escapeHtml(paper.age)}` : '| Awaiting OCR details'}
                        ${paper.room_no ? `| Room: ${escapeHtml(paper.room_no)}` : ''}
                        ${paper.seat_no ? `| Seat: ${escapeHtml(paper.seat_no)}` : ''}
                    </p>
                    <p class="small text-muted">${new Date(paper.timestamp).toLocaleString()}</p>
                </div>
            `;
        }

        const actions = document.getElementById('receivedPaperActions');
        if (actions) actions.classList.remove('d-none');

        const removeBtn = document.getElementById('removeReceivedPaperBtn');
        if (removeBtn) removeBtn.onclick = () => this.deleteReceivedPaper(id);

        const scanBtn = document.getElementById('scanReceivedPaperBtn');
        if (scanBtn) scanBtn.onclick = () => this.processPaper(id);
    }

    clearReceivedPaperPreview() {
        this.selectedReceivedPaperId = null;
        const preview = document.getElementById('receivedPaperPreview');
        if (preview) {
            preview.innerHTML = `
                <i class="fas fa-file-image fa-4x text-muted mb-3"></i>
                <p class="text-muted">Select a paper from the list to preview</p>
            `;
        }
        const actions = document.getElementById('receivedPaperActions');
        if (actions) actions.classList.add('d-none');
    }

    async deleteReceivedPaper(id) {
        if (!confirm('Are you sure you want to delete this paper?')) return;
        try {
            await this.apiCallWithAuth(`/api/received-papers/${id}`, { method: 'DELETE' }, 'deleteReceivedPaper');
            toastManager.showSuccess('Paper deleted');
            this.clearReceivedPaperPreview();
            this.loadReceivedPapers();
        } catch (error) {
            // Error already handled by apiCallWithAuth
        }
    }

    async processPaper(paperId) {
        const paper = this.receivedPapers.find(p => p.id === paperId);
        if (!paper) return;
        const imageUrl = this.getReceivedPaperImageUrl(paper);

        location.hash = '#/scan';

        setTimeout(() => {
            this.setScannerPreviewImage(imageUrl, paper.student_name || 'Paper Preview');
            this.selectedScanImage = imageUrl;
            this.selectedScanImages = [];
            this.bulkScanResults = [];
            this.selectedReceivedPaperId = paper.id;
            this.currentOcrResult = null;
            this.detectedScannerLayout = null;
            this.scannerAiInputPreviewImage = null;
            this.renderBulkScanQueue();
            this.updateScannerScanButtonState();
            this.identifyScannerLayout(imageUrl);

            if (document.getElementById('scannerStudentName')) document.getElementById('scannerStudentName').value = paper.student_name || '';
            if (document.getElementById('scannerStudentCourse')) document.getElementById('scannerStudentCourse').value = paper.course || '';
            if (document.getElementById('scannerStudentAge')) document.getElementById('scannerStudentAge').value = paper.age || '';
            if (document.getElementById('scannerRoomNo')) document.getElementById('scannerRoomNo').value = paper.room_no || '';
            if (document.getElementById('scannerSeatNo')) document.getElementById('scannerSeatNo').value = paper.seat_no || '';
            if (document.getElementById('scannerEntryType')) document.getElementById('scannerEntryType').value = paper.entry_type || '';
            if (document.getElementById('scannerEquityGroup')) document.getElementById('scannerEquityGroup').value = paper.equity_group || 'None';

            this.showToast(`Loaded paper for ${paper.student_name || 'received image'}`, 'info');
        }, 500);
    }

    readScannerFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error(`Failed to read ${file?.name || 'image'}`));
            reader.readAsDataURL(file);
        });
    }

    async compressScannerImageForUpload(imageData, options = {}) {
        const value = String(imageData || '');
        if (!value.startsWith('data:image/')) return imageData;

        const maxDimension = Number(options.maxDimension || 2200);
        const quality = Number(options.quality || 0.9);
        const approximateBytes = Math.round((value.length * 3) / 4);
        if (approximateBytes < 1_500_000) return imageData;

        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
                    if (scale >= 1 && approximateBytes < 2_500_000) {
                        resolve(imageData);
                        return;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
                    canvas.height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
                    const ctx = canvas.getContext('2d', { alpha: false });
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch (error) {
                    console.warn('Scanner image compression failed; using original upload payload.', error);
                    resolve(imageData);
                }
            };
            img.onerror = () => resolve(imageData);
            img.src = imageData;
        });
    }

    setScannerPreviewImage(imageData, label = 'Preview') {
        this.scannerOriginalPreviewImage = imageData;
        this.scannerPreviewMode = this.scannerPreviewMode || 'original';
        this.setScannerPreviewMode(this.scannerPreviewMode, { preserveTransform: true, skipValidation: true });
        this.validateImageQuality(imageData);
    }

    setScannerPreviewMode(mode = 'original', options = {}) {
        const requestedMode = ['original', 'aiInput', 'results'].includes(mode) ? mode : 'original';
        const hasAiInput = Boolean(this.scannerAiInputPreviewImage);
        const hasResults = Boolean(this.currentOcrResult);
        const nextMode = requestedMode === 'aiInput' && !hasAiInput
            ? 'original'
            : (requestedMode === 'results' && !hasResults ? 'original' : requestedMode);

        this.scannerPreviewMode = nextMode;
        const buttons = {
            original: document.getElementById('scannerPreviewTabOriginal'),
            aiInput: document.getElementById('scannerPreviewTabAiInput'),
            results: document.getElementById('scannerPreviewTabResults')
        };
        Object.entries(buttons).forEach(([key, btn]) => {
            if (!btn) return;
            const active = key === nextMode;
            btn.classList.toggle('btn-primary', active);
            btn.classList.toggle('btn-outline-primary', !active);
        });
        if (buttons.aiInput) buttons.aiInput.disabled = !hasAiInput;
        if (buttons.results) buttons.results.disabled = !hasResults;

        const preview = document.getElementById('scannerImagePreview');
        const controls = document.getElementById('scannerImageControls');
        if (!preview) return;

        if (nextMode === 'results') {
            preview.innerHTML = this.buildScannerResultsPreviewHtml(this.currentOcrResult);
            preview.classList.remove('border-dashed');
            if (controls) controls.classList.add('d-none');
            return;
        }

        const imageData = nextMode === 'aiInput' ? this.scannerAiInputPreviewImage : this.scannerOriginalPreviewImage;
        if (!imageData) {
            preview.innerHTML = `
                <div class="scanner-preview-empty">
                    <i class="fas fa-image fa-2x mb-3 opacity-50"></i>
                    <div class="fw-bold">${nextMode === 'aiInput' ? 'AI Input not available' : 'No image uploaded'}</div>
                    <div class="small text-muted">${nextMode === 'aiInput' ? 'Run a scan to view the prepared AI input.' : 'Upload a clear answer sheet to begin.'}</div>
                </div>
            `;
            if (controls) controls.classList.add('d-none');
            return;
        }

        preview.innerHTML = `<img src="${imageData}" id="activeScannerImage" class="scanner-preview-image rounded shadow" alt="${escapeHtml(nextMode === 'aiInput' ? 'AI input preview' : 'Original preview')}" draggable="false">`;
        preview.classList.remove('border-dashed');
        if (controls) controls.classList.remove('d-none');
        if (!options.preserveTransform) {
            this.imageRotation = 0;
            this.imageZoom = 1;
            this.imagePanX = 0;
            this.imagePanY = 0;
        }
        this.applyScannerImageTransform();
        this.initScannerPreviewInteractions();
        if (!options.skipValidation) this.validateImageQuality(imageData);
    }

    buildScannerResultsPreviewHtml(result = {}) {
        if (!result?.success) {
            return `
                <div class="scanner-preview-empty">
                    <i class="fas fa-chart-bar fa-2x mb-3 opacity-50"></i>
                    <div class="fw-bold">No result available</div>
                    <div class="small text-muted">Scan a paper to view section results.</div>
                </div>
            `;
        }
        const questionMetrics = Array.isArray(result.questionMetrics) ? result.questionMetrics : [];
        const sections = result.templateMetrics?.sections || result.metrics?.sections || [];
        const total = Number(result.totalTemplateQuestions || result.activeQuestionCount || questionMetrics.length || 0);
        const explicitReviewQuestions = Array.isArray(result.needsReview) ? result.needsReview : [];
        const metricReviewQuestions = questionMetrics
            .filter((metric) => {
                const state = String(metric.state || '').toLowerCase();
                return metric.needsReview || state === 'uncertain';
            })
            .map((metric) => Number(metric.questionNumber ?? metric.question))
            .filter(Number.isFinite);
        const reviewQuestions = new Set([...explicitReviewQuestions.map(Number), ...metricReviewQuestions]);
        const rows = Array.isArray(sections) && sections.length
            ? sections.map((section, index) => {
                const sectionQuestions = Array.isArray(section.questions) ? section.questions.map(Number).filter(Number.isFinite) : [];
                const start = Number(section.startQuestion || section.start || section.firstQuestion || sectionQuestions[0] || index * 20 + 1);
                const end = Number(section.endQuestion || section.end || section.lastQuestion || sectionQuestions[sectionQuestions.length - 1] || start + Number(section.questionCount || 20) - 1);
                const label = section.subject || section.name || section.label || `Section ${index + 1}`;
                const expected = Math.max(0, end - start + 1);
                const read = questionMetrics.filter((metric) => {
                    const q = Number(metric.questionNumber ?? metric.question);
                    const state = String(metric.state || '').toLowerCase();
                    return q >= start && q <= end && state !== 'ignored';
                }).length || Math.min(expected, total);
                const review = Array.from(reviewQuestions).filter((q) => q >= start && q <= end).length;
                return { label, read, expected, review };
            })
            : [{ label: 'Answers', read: Number(result.metrics?.returnedQuestions || questionMetrics.length || total), expected: total, review: reviewQuestions.size }];

        return `
            <div class="scanner-results-summary">
                <div class="text-center mb-2">
                    <div class="fw-bold text-dark">AI Vision Results</div>
                    <div class="small text-muted">Section-level recognition summary</div>
                </div>
                ${rows.map((row) => `
                    <div class="scanner-results-row">
                        <strong>${escapeHtml(row.label)}</strong>
                        <span class="small text-muted">${row.read} / ${row.expected}</span>
                        <span class="badge ${row.review > 0 ? 'bg-warning text-dark' : 'bg-success'}">${row.review > 0 ? `Review ${row.review}` : 'Complete'}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    async handleScannerImageSelect(event) {
        const files = Array.from(event.target.files || []).filter((file) => String(file.type || '').startsWith('image/'));
        if (!files.length) return;

        const maxBulk = 20;
        const selectedFiles = files.slice(0, maxBulk);
        if (files.length > maxBulk) {
            this.showToast(`Only the first ${maxBulk} images were added to the bulk queue.`, 'warning');
        }

        try {
            const queue = [];
            for (const [index, file] of selectedFiles.entries()) {
                queue.push({
                    id: `${Date.now()}-${index}`,
                    name: file.name || `Paper ${index + 1}`,
                    dataUrl: await this.readScannerFileAsDataUrl(file),
                    status: 'ready',
                    result: null,
                    error: ''
                });
            }

            this.selectedScanImages = queue;
            this.bulkScanResults = [];
            this.selectedScanImage = queue[0]?.dataUrl || null;
            this.selectedInboxPaperIds = [];
            this.selectedReceivedPaperId = null;
            this.currentOcrResult = null;
            this.detectedScannerLayout = null;
            this.scannerAiInputPreviewImage = null;
            if (this.selectedScanImage) {
                this.setScannerPreviewImage(this.selectedScanImage, queue[0]?.name || 'Preview');
                this.identifyScannerLayout(this.selectedScanImage);
            }
            this.renderBulkScanQueue();
            this.updateScannerScanButtonState();
        } catch (error) {
            console.error('Image selection failed:', error);
            this.showToast(error.message || 'Failed to load selected images.', 'danger');
        }
    }

    setBubbleDebugOriginalPreview(imageData, label = 'Debug image') {
        const preview = document.getElementById('bubbleDebugOriginalPreview');
        if (!preview) return;
        preview.innerHTML = `<img src="${imageData}" class="img-fluid" alt="${escapeHtml(label)}">`;
    }

    getBubbleDebugAssetUrl(assetPath) {
        const rawPath = String(assetPath || '').trim();
        if (!rawPath) return null;
        if (/^(https?:|data:)/i.test(rawPath)) return rawPath;
        const apiPath = rawPath.startsWith('/uploads/') ? `/api${rawPath}` : rawPath;
        return scanCheckConfig.resolveAssetUrl(apiPath);
    }

    async validateImageQuality(base64) {
        const img = new Image();
        img.onload = () => {
            const resText = document.getElementById('imageResolutionText');
            if (resText) resText.textContent = `${img.width}x${img.height}`;

            const badge = document.getElementById('imageQualityBadge');
            let quality = 'Good';
            let badgeClass = 'bg-success';

            if (img.width < 800 || img.height < 800) {
                quality = 'Poor (Low Res)';
                badgeClass = 'bg-danger';
            }

            if (badge) {
                badge.textContent = quality;
                badge.className = `badge ${badgeClass}`;
            }
        };
        img.src = base64;
    }

    rotateImage(deg) {
        this.imageRotation = (this.imageRotation + deg) % 360;
        this.applyScannerImageTransform();
    }

    zoomImage(factor) {
        this.imageZoom *= factor;
        this.imageZoom = Math.max(0.4, Math.min(6, this.imageZoom));
        this.applyScannerImageTransform();
    }

    applyScannerImageTransform() {
        const img = document.getElementById('activeScannerImage');
        const level = document.getElementById('scannerZoomLevel');
        if (!img) return;
        img.style.transform = `translate(${this.imagePanX}px, ${this.imagePanY}px) rotate(${this.imageRotation}deg) scale(${this.imageZoom})`;
        if (level) level.textContent = `${Math.round(this.imageZoom * 100)}%`;
    }

    fitScannerPreviewImage() {
        this.imageZoom = 1;
        this.imagePanX = 0;
        this.imagePanY = 0;
        this.applyScannerImageTransform();
    }

    initScannerPreviewInteractions() {
        const shell = document.getElementById('scannerImagePreviewShell');
        if (!shell) return;

        shell.onmousedown = (event) => {
            if (event.button !== 0 || !document.getElementById('activeScannerImage')) return;
            this.scannerImageDragging = true;
            this.scannerImageDragStartX = event.clientX - this.imagePanX;
            this.scannerImageDragStartY = event.clientY - this.imagePanY;
            shell.style.cursor = 'grabbing';
            event.preventDefault();
        };

        shell.onmousemove = (event) => {
            if (!this.scannerImageDragging) return;
            this.imagePanX = event.clientX - this.scannerImageDragStartX;
            this.imagePanY = event.clientY - this.scannerImageDragStartY;
            this.applyScannerImageTransform();
        };

        shell.onmouseup = () => {
            this.scannerImageDragging = false;
            shell.style.cursor = 'grab';
        };

        shell.onmouseleave = () => {
            this.scannerImageDragging = false;
            shell.style.cursor = 'grab';
        };

        shell.ontouchstart = (event) => {
            const touch = event.touches?.[0];
            if (!touch || !document.getElementById('activeScannerImage')) return;
            this.scannerImageDragging = true;
            this.scannerImageDragStartX = touch.clientX - this.imagePanX;
            this.scannerImageDragStartY = touch.clientY - this.imagePanY;
        };

        shell.ontouchmove = (event) => {
            if (!this.scannerImageDragging) return;
            const touch = event.touches?.[0];
            if (!touch) return;
            event.preventDefault();
            this.imagePanX = touch.clientX - this.scannerImageDragStartX;
            this.imagePanY = touch.clientY - this.scannerImageDragStartY;
            this.applyScannerImageTransform();
        };

        shell.ontouchend = () => {
            this.scannerImageDragging = false;
        };

        shell.onwheel = (event) => {
            if (!document.getElementById('activeScannerImage')) return;
            event.preventDefault();
            this.zoomImage(event.deltaY > 0 ? 0.9 : 1.1);
        };
    }

    updateScannerScanButtonState() {
        const scanBtn = document.getElementById('startScanBtn');
        if (!scanBtn) return;
        const selectedQuizId = document.getElementById('scannerExamSelect')?.value || '';
        const hasResolvedLayout = Boolean(this.detectedScannerLayout?.layoutId || selectedQuizId);
        const queueCount = Array.isArray(this.selectedScanImages) ? this.selectedScanImages.length : 0;
        scanBtn.disabled = this.isBulkScanning || !(this.selectedScanImage && hasResolvedLayout);
        scanBtn.innerHTML = queueCount > 1
            ? `<i class="fas fa-layer-group me-2"></i> Scan ${queueCount} Images`
            : '<i class="fas fa-search me-2"></i> Scan Paper';
    }

    renderBulkScanQueue() {
        const panel = document.getElementById('bulkScanPanel');
        const count = document.getElementById('bulkScanCount');
        const list = document.getElementById('bulkScanList');
        const progressBar = document.getElementById('bulkScanProgressBar');
        const queueHeader = document.getElementById('scannerQueueHeader');
        const thumbnailsContainer = document.getElementById('scannerThumbnails');
        
        const queue = Array.isArray(this.selectedScanImages) ? this.selectedScanImages : [];
        
        if (!panel || !list || !count) return;

        if (queue.length <= 1) {
            panel.classList.add('d-none');
            if (queueHeader) queueHeader.classList.add('d-none');
            if (progressBar) progressBar.style.width = '0%';
            return;
        }

        const done = queue.filter((item) => ['done', 'failed'].includes(item.status)).length;
        panel.classList.remove('d-none');
        if (queueHeader) queueHeader.classList.remove('d-flex');
        if (queueHeader) queueHeader.classList.remove('d-none');
        if (queueHeader) queueHeader.classList.add('d-flex');
        
        count.textContent = `${queue.length} papers`;
        if (progressBar) progressBar.style.width = `${Math.round((done / queue.length) * 100)}%`;

        // Render thumbnails
        if (thumbnailsContainer) {
            thumbnailsContainer.innerHTML = queue.map((item, index) => `
                <img src="${item.dataUrl}" 
                     class="scanner-thumbnail ${this.selectedScanImage === item.dataUrl ? 'active' : ''}" 
                     onclick="app.switchScannerImage(${index})" 
                     title="${escapeHtml(item.name)}">
            `).join('');
        }

        list.innerHTML = queue.map((item, index) => {
            const statusMap = {
                ready: ['secondary', 'Ready', 'fa-clock'],
                running: ['primary', 'Scanning', 'fa-spinner fa-spin'],
                done: ['success', 'Done', 'fa-check-circle'],
                failed: ['danger', 'Failed', 'fa-exclamation-circle']
            };
            const [tone, label, icon] = statusMap[item.status] || statusMap.ready;
            const canView = item.status === 'done' && item.result;
            const isActive = this.selectedScanImage === item.dataUrl;
            const title = item.error ? ` title="${escapeHtml(item.error)}"` : '';
            
            return `
                <div class="bulk-scan-row ${isActive ? 'border-primary bg-primary bg-opacity-10 shadow-sm' : ''}" 
                     style="cursor: pointer; transition: all 0.2s;"
                     onclick="app.switchScannerImage(${index})" ${title}>
                    <div class="text-truncate flex-grow-1 d-flex align-items-center gap-2">
                        <span class="fw-bold text-muted small" style="min-width: 1.5rem;">${index + 1}.</span>
                        <div class="text-truncate">
                            <div class="fw-semibold text-dark text-truncate">${escapeHtml(item.name)}</div>
                            <div class="x-small text-muted">${item.status === 'failed' ? escapeHtml(item.error) : label}</div>
                        </div>
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        <i class="fas ${icon} text-${tone}"></i>
                        ${canView ? `<button type="button" class="btn btn-link btn-sm p-0 text-primary text-decoration-none" onclick="event.stopPropagation(); app.openBulkScanResult(${index})">View</button>` : ''}
                        <button type="button" class="btn btn-link btn-sm p-0 text-danger opacity-50 hover-opacity-100" onclick="event.stopPropagation(); app.removeFromBulkQueue(${index})"><i class="fas fa-times-circle"></i></button>
                    </div>
                </div>
            `;
        }).join('');
    }

    switchScannerImage(index) {
        const queue = this.selectedScanImages;
        if (!queue || !queue[index]) return;
        
        this.selectedScanImage = queue[index].dataUrl;
        this.currentOcrResult = queue[index].result || null;
        this.scannerAiInputPreviewImage = this.currentOcrResult?.aiInputPreview || this.currentOcrResult?.metrics?.aiInputPreview || null;
        this.setScannerPreviewImage(this.selectedScanImage, queue[index].name);
        if (!this.currentOcrResult) this.identifyScannerLayout(this.selectedScanImage);
        this.renderBulkScanQueue();
    }

    removeFromBulkQueue(index) {
        if (!Array.isArray(this.selectedScanImages)) return;
        
        const isCurrentlySelected = this.selectedScanImage === this.selectedScanImages[index]?.dataUrl;
        this.selectedScanImages.splice(index, 1);
        
        if (this.selectedScanImages.length === 0) {
            this.clearScannerImage();
        } else {
            if (isCurrentlySelected) {
                this.switchScannerImage(0);
            } else {
                this.renderBulkScanQueue();
                this.updateScannerScanButtonState();
            }
        }
    }

    updateLastResultButtonState() {
        const btn = document.getElementById('openLastResultBtn');
        if (!btn) return;
        btn.disabled = !this.currentOcrResult;
    }

    getScanResultExamId(result = {}) {
        const qr = result?.barcodeData || {};
        return String(
            result?.examId
            || result?.exam_id
            || qr.examId
            || qr.exam_id
            || ''
        ).trim();
    }

    formatScanScoreSummary(result = {}) {
        if (!result) return '-';
        const subjectScores = result.subjectScores || {};
        const rawScore = Number(result.totalScore ?? subjectScores.totalScore ?? result.score);
        const rawTotal = Number(result.totalQuestions ?? subjectScores.totalQuestions);
        const percentage = result.percentage ?? subjectScores.overallPercentage;
        const scoringStatus = result.scoringStatus ? ` (${result.scoringStatus})` : '';

        if (Number.isFinite(rawScore) && Number.isFinite(rawTotal) && rawTotal > 0) {
            const pctText = percentage != null && percentage !== '' ? `, ${percentage}%` : '';
            return `${rawScore}/${rawTotal}${pctText}${scoringStatus}`;
        }
        if (Number.isFinite(rawScore)) return `${rawScore}${scoringStatus}`;
        return result.scoringStatus || '-';
    }

    formatChoiceGroupSummary(group, fallbackValue = '') {
        const fallbackText = typeof fallbackValue === 'string' ? fallbackValue : '';
        if (!group) return fallbackText || '-';
        if (typeof group === 'string') return group || fallbackText || '-';

        const studentType = group.studentType ? String(group.studentType) : '';
        const residencyType = group.residencyType ? String(group.residencyType) : '';
        if (studentType && residencyType) {
            return `${studentType} / ${residencyType}`;
        }
        if (studentType) return `${studentType}`;

        const status = group.state || group.status || '';
        const value = group.value != null && group.value !== '' ? String(group.value) : '';
        const values = Array.isArray(group.values) ? group.values.filter(Boolean).map(String) : [];
        const detected = Array.isArray(group.detected)
            ? group.detected.map((item) => item?.label).filter(Boolean).map(String)
            : [];
        const labels = values.length ? values : detected;

        if (value) return status ? `${value} (${status})` : value;
        if (labels.length) return status ? `${labels.join(', ')} (${status})` : labels.join(', ');
        return status || fallbackText || '-';
    }

    scannerSelectedQuizContext() {
        const quizId = document.getElementById('scannerExamSelect')?.value || '';
        const selectedQuiz = this.quizzes.find((quiz) => String(quiz.id) === String(quizId)) || null;
        return {
            quizId: quizId || null,
            quiz: selectedQuiz,
            questionCount: Number.parseInt(String(selectedQuiz?.questionCount || 100), 10) || 100,
            subjects: this.getSubjectConfigForQuiz(selectedQuiz || quizId)
        };
    }

    updateScannerStatusBadge(status = 'idle') {
        const badge = document.getElementById('scannerStatusBadge');
        if (!badge) return;
        const normalized = String(status || 'idle').toLowerCase();
        const map = {
            idle: ['bg-secondary', 'Idle'],
            processing: ['bg-primary', 'Processing'],
            complete: ['bg-success', 'Complete'],
            review: ['bg-warning text-dark', 'Needs Review'],
            failed: ['bg-danger', 'Failed']
        };
        const [classes, label] = map[normalized] || map.idle;
        badge.className = `badge ${classes}`;
        badge.textContent = label;
    }

    setScannerStage(activeStage = '') {
        const rows = document.querySelectorAll('.scanner-stage-row');
        const order = ['prepare', 'layout', 'analyze', 'validate'];
        const activeIndex = order.indexOf(activeStage);
        rows.forEach((row) => {
            const stage = row.dataset.stage;
            const stageIndex = order.indexOf(stage);
            const icon = row.querySelector('i');
            row.classList.toggle('active', stage === activeStage);
            row.classList.toggle('complete', activeIndex > stageIndex && stageIndex >= 0);
            if (!icon) return;
            if (activeIndex > stageIndex && stageIndex >= 0) {
                icon.className = 'fas fa-check-circle';
            } else if (stage === activeStage) {
                icon.className = 'fas fa-circle-notch fa-spin';
            } else {
                icon.className = 'far fa-circle';
            }
        });
    }

    setScannerAiStatus(status = 'ready') {
        const badge = document.getElementById('scannerAiStatusBadge');
        if (!badge) return;
        const normalized = String(status || 'ready').toLowerCase();
        const map = {
            ready: ['bg-success', 'Ready'],
            checking: ['bg-primary', 'Checking'],
            unavailable: ['bg-danger', 'Unavailable'],
            processing: ['bg-primary', 'Processing']
        };
        const [classes, label] = map[normalized] || map.ready;
        badge.className = `badge ${classes}`;
        badge.textContent = label;
    }

    renderScannerLayoutDetection(result = null, state = 'idle') {
        const card = document.getElementById('scannerDetectedExamCard');
        const name = document.getElementById('scannerDetectedExamName');
        const count = document.getElementById('scannerDetectedQuestionCount');
        const source = document.getElementById('scannerDetectedSource');
        const manualLabel = document.getElementById('scannerManualOverrideLabel');
        const help = document.getElementById('scannerExamHelpText');
        const select = document.getElementById('scannerExamSelect');

        if (state === 'checking') {
            if (card) card.classList.remove('d-none');
            if (name) name.textContent = 'Reading sheet QR...';
            if (count) count.textContent = '-';
            if (source) source.textContent = 'Identifying layout';
            if (manualLabel) manualLabel.classList.add('text-muted');
            if (help) help.textContent = 'Manual override remains available if the QR cannot be read.';
            return;
        }

        if (result?.success) {
            if (card) card.classList.remove('d-none');
            if (name) name.textContent = result.examName || result.examId || result.layoutId || 'Detected Exam';
            if (count) count.textContent = result.questionCount || '-';
            if (source) source.textContent = result.detectedFromQr ? 'Detected from QR' : 'Resolved from layout';
            if (manualLabel) manualLabel.classList.add('text-muted');
            if (help) help.textContent = 'Manual override is optional. Use it only if the detected exam is wrong.';
            if (select && result.quizId) {
                select.value = String(result.quizId);
                localStorage.setItem('scancheck_selected_scanner_quiz', String(result.quizId));
            }
            return;
        }

        if (card) card.classList.add('d-none');
        if (manualLabel) manualLabel.classList.remove('text-muted');
        if (help) {
            help.textContent = state === 'failed'
                ? 'Could not identify sheet layout. Select the target exam manually.'
                : 'Used when QR/layout detection needs manual confirmation.';
        }
    }

    friendlyScanError(error) {
        const code = String(error?.code || error?.payload?.code || '').toUpperCase();
        const message = String(error?.payload?.error || error?.message || error || '').toLowerCase();
        if (message.includes('layout identification') || message.includes('qr could not')) {
            return 'Could not identify sheet layout. Use Manual Override if this is a valid ScanCheck sheet.';
        }
        if (code.includes('MISSING_API_KEY') || code.includes('AUTH') || message.includes('api key') || message.includes('authentication') || message.includes('quota') || message.includes('rate limit')) {
            return 'AI scanner unavailable. Check the Gemini API key, billing, or connection.';
        }
        if (code.includes('TIMEOUT') || message.includes('timeout') || message.includes('timed out')) {
            return 'AI scanner timed out. Try again, or use fewer verification calls in AI settings.';
        }
        if (code.includes('INVALID_RESPONSE') || code.includes('MALFORMED')) {
            return 'AI scanner returned an unreadable response. Try scanning again.';
        }
        if (message.includes('image') || message.includes('payload')) {
            return 'The uploaded image could not be processed.';
        }
        return 'The paper could not be scanned. Please try a clearer image.';
    }

    async identifyScannerLayout(imageData) {
        if (!imageData) return null;
        this.detectedScannerLayout = null;
        this.renderScannerLayoutDetection(null, 'checking');
        this.setScannerAiStatus('checking');
        this.updateScannerScanButtonState();
        try {
            const context = this.scannerSelectedQuizContext();
            const response = await scanCheckConfig.apiCall('/api/ai-omr/identify-layout', {
                method: 'POST',
                body: JSON.stringify({
                    photo: imageData,
                    quizId: context.quizId,
                    questionCount: context.questionCount,
                    subjects: context.subjects
                })
            }, 'identifyLayout');
            this.detectedScannerLayout = response?.success ? response : null;
            this.renderScannerLayoutDetection(this.detectedScannerLayout, this.detectedScannerLayout ? 'success' : 'failed');
            this.setScannerAiStatus('ready');
            this.updateScannerScanButtonState();
            return this.detectedScannerLayout;
        } catch (error) {
            console.warn('Layout identification failed:', error?.message || error);
            this.detectedScannerLayout = null;
            this.renderScannerLayoutDetection(null, 'failed');
            this.setScannerAiStatus('ready');
            this.updateScannerScanButtonState();
            return null;
        }
    }

    scannerResultStatus(result = {}) {
        const metrics = result.templateMetrics || result.metrics || {};
        const stateCounts = metrics.stateCounts || {};
        const metricReviewCount = Array.isArray(result.questionMetrics)
            ? result.questionMetrics.filter((metric) => metric.needsReview || String(metric.state || '').toLowerCase() === 'uncertain').length
            : Number(stateCounts.uncertain || 0);
        const needsReview = Array.isArray(result.needsReview) ? result.needsReview.length : metricReviewCount;
        if (!result?.success) return 'Failed';
        return needsReview > 0 ? 'Needs Review' : 'Complete';
    }

    updateScannerPipelineSummary(result = null) {
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value == null || value === '' ? '-' : String(value);
        };

        if (!result) {
            [
                'scannerMetaExamId',
                'scannerMetaQuestionsRead',
                'scannerMetaNeedsReview',
                'scannerMetaScanStatus',
                'scannerMetaProcessingTime',
                'scannerMetaWorkerUsed',
            ].forEach((id) => setText(id, '-'));
            this.updateScannerStatusBadge('idle');
            return;
        }

        const examId = this.getScanResultExamId(result);
        const metrics = result.templateMetrics || result.metrics || {};
        const stateCounts = metrics.stateCounts || {};
        const returnedCount = Number(metrics.returnedQuestions || result.activeQuestionCount || result.questionMetrics?.length || 0) || 0;
        const totalQuestions = Number(result.totalTemplateQuestions || result.activeQuestionCount || returnedCount) || returnedCount;
        const reviewCount = Array.isArray(result.needsReview)
            ? result.needsReview.length
            : (Array.isArray(result.questionMetrics)
                ? result.questionMetrics.filter((metric) => metric.needsReview || String(metric.state || '').toLowerCase() === 'uncertain').length
                : Number(stateCounts.uncertain || 0));
        const status = this.scannerResultStatus(result);
        const processingMs = Number(metrics.processingTimeMs || metrics.latencyMs || result.processingTimeMs);

        const selectedQuiz = this.scannerSelectedQuizContext().quiz;
        setText('scannerMetaExamId', result.examName || selectedQuiz?.title || examId || result.layoutId || '-');
        setText('scannerMetaQuestionsRead', totalQuestions > 0 ? `${returnedCount}/${totalQuestions}` : '-');
        setText('scannerMetaNeedsReview', reviewCount);
        setText('scannerMetaScanStatus', status);
        setText('scannerMetaProcessingTime', Number.isFinite(processingMs) && processingMs > 0 ? `${(processingMs / 1000).toFixed(1)} s` : '-');
        setText('scannerMetaWorkerUsed', 'AI Vision');
        this.updateScannerStatusBadge(status === 'Needs Review' ? 'review' : 'complete');
    }

    openLastScanResult() {
        if (!this.currentOcrResult) {
            this.showToast('No previous result found. Scan an image first.', 'warning');
            return;
        }

        this.presentOcrResult(this.currentOcrResult, { showModal: true, silent: true });
    }

    getScannerOcrRequestPayload(imageData, options = {}) {
        const context = this.scannerSelectedQuizContext();
        const detected = this.detectedScannerLayout || {};
        const quizId = context.quizId || detected.quizId || null;
        const questionCount = Number.parseInt(String(detected.questionCount || context.questionCount || 100), 10) || 100;
        return {
            photo: imageData,
            layoutId: detected.layoutId || null,
            quizId,
            sourceReceivedPaperId: options.sourceReceivedPaperId || null,
            rotation: options.rotation ?? this.imageRotation,
            sheetFormat: 'multi-subject',
            questionCount,
            subjects: context.subjects
        };
    }

    async processScannerImageData(imageData, options = {}) {
        const uploadImage = await this.compressScannerImageForUpload(imageData);
        return this.apiCallWithAuth('/api/ocr', {
            method: 'POST',
            body: JSON.stringify(this.getScannerOcrRequestPayload(uploadImage, options))
        }, options.context || 'processOCR');
    }

    presentOcrResult(result, options = {}) {
        if (!result?.success) {
            if (!result.layoutFound || result.requiresLayout) {
                const layoutId = result.layoutId || result.examId || 'unknown';
                this.showToast(
                    `Layout ${layoutId} was not found. This sheet cannot be scanned on this computer unless the matching layout JSON is restored. Generate a new answer sheet and scan the new one.`,
                    'danger',
                    8000
                );
            } else {
                this.showToast(result?.message || 'Invalid OMR sheet detected. Please upload a clear exam paper.', 'danger');
            }
            return false;
        }

        this.currentOcrResult = result;
        this.scannerAiInputPreviewImage = result.aiInputPreview || result.templateMetrics?.aiInputPreview || result.metrics?.aiInputPreview || this.scannerAiInputPreviewImage || null;
        // Keep track of source ID in result so it's not lost
        if (options.sourceReceivedPaperId) {
            this.currentOcrResult.sourceReceivedPaperId = options.sourceReceivedPaperId;
        }

        console.log(`[OCR presentOcrResult] requestId=${result.requestId} sourceId=${this.currentOcrResult.sourceReceivedPaperId || ''} hash=${(result.imageHash || '').slice(0, 12)} debugPath=${result.debugImagePath || ''}`);
        
        this.updateLastResultButtonState();
        this.updateScannerPipelineSummary(result);
        const qr = result.barcodeData || {};
        const firstNonEmpty = (...values) => {
            for (const value of values) {
                const text = String(value ?? '').trim();
                if (text) return text;
            }
            return '';
        };
        const qrSheetId = String(result.sheetId || result.sheet_id || qr.sheetId || qr.sheet_id || '').trim();
        const resolvedPaperId = qrSheetId;
        const setPreviewField = (id, value, invalid = false) => {
            const element = document.getElementById(id);
            if (!element) return;
            element.value = value || '';
            element.classList.toggle('is-invalid', Boolean(invalid));
        };
        const topField = (fieldName) => result.topFields?.[fieldName] || result.classificationFields?.[fieldName] || {};

        // Auto-fill form fields
        if (document.getElementById('ocrStudentName')) document.getElementById('ocrStudentName').value = firstNonEmpty(result.studentName, result.student_name, qr.studentName, qr.student_name, qr.name);
        if (document.getElementById('ocrPaperId')) document.getElementById('ocrPaperId').value = resolvedPaperId;
        if (document.getElementById('ocrStudentCourse')) document.getElementById('ocrStudentCourse').value = firstNonEmpty(result.course, qr.course);
        if (document.getElementById('ocrStudentAge')) document.getElementById('ocrStudentAge').value = firstNonEmpty(result.age, qr.age);
        if (document.getElementById('ocrRoomNo')) document.getElementById('ocrRoomNo').value = firstNonEmpty(result.roomNo, result.room_no, qr.roomNo, qr.room_no, qr.room);
        if (document.getElementById('ocrSeatNo')) document.getElementById('ocrSeatNo').value = firstNonEmpty(result.seatNo, result.seat_no, qr.seatNo, qr.seat_no, qr.seat);
        if (document.getElementById('ocrDateTime')) {
            const dt = firstNonEmpty(result.dateTime, result.date_time, qr.dateTime, qr.date_time);
            document.getElementById('ocrDateTime').value = dt;
        }
        if (document.getElementById('ocrScore')) document.getElementById('ocrScore').value = result.score || 0;

        if (document.getElementById('ocrSex')) {
            const sexField = topField('sex');
            setPreviewField('ocrSex', firstNonEmpty(result.sex, qr.sex, qr.gender, sexField.value), sexField.invalid);
        }
        if (document.getElementById('ocrEntryType')) {
            const eg = result.entryGroup || {};
            setPreviewField('ocrEntryType', eg.studentType || result.entryType || 'New Student', topField('studentType').invalid);
        }
        if (document.getElementById('ocrResidencyType')) {
            const eg = result.entryGroup || {};
            setPreviewField('ocrResidencyType', eg.residencyType || result.residencyType || 'Passinhon', topField('residencyType').invalid);
        }
        if (document.getElementById('ocrEquityGroup')) {
            const eq = result.equityGroupResult || {};
            const eqValues = Array.isArray(eq.values) ? eq.values.filter(Boolean) : [];
            setPreviewField('ocrEquityGroup', eqValues.length ? eqValues[0] : (result.equityGroup || eq.value || 'None'), topField('equityGroup').invalid);
        }
        if (document.getElementById('ocrRawText')) document.getElementById('ocrRawText').value = result.rawText || '';

        this.renderOCRAnswers(result.answers || [], result.confidence || {}, result.correctAnswers || [], result.questionMetrics || []);
        this.renderOmrDebugLog(result);
        this.applyScannerViewSettings();
        this.updateConfidenceAnalysis(result);
        this.updateDebugPreview(result.debugImagePath || null);
        this.renderImagePreview(result);
        this.setScannerPreviewMode(this.scannerPreviewMode || 'results', { preserveTransform: true, skipValidation: true });

        if (!options.silent) {
            if (resolvedPaperId) {
                this.showToast('QR detected. Sheet ID loaded from QR.', 'success');
            }
        }

        if (options.showModal !== false) {
            const modalEl = document.getElementById('ocrResultsModal');
            if (modalEl) {
                const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
                modal.show();
            }
        }
        
        // Refresh inbox data to reflect newly scanned status
        this.loadReceivedPapers();
        
        return true;
    }

    openBulkScanResult(index) {
        const item = this.selectedScanImages[index];
        if (!item?.result) {
            this.showToast('This paper has no completed result yet.', 'warning');
            return;
        }
        this.selectedScanImage = item.dataUrl;
        this.setScannerPreviewImage(item.dataUrl, item.name);
        this.presentOcrResult(item.result, { showModal: true });
    }

    clearCurrentOcrResultOnly() {
        this.currentOcrResult = null;
        this.scannerAiInputPreviewImage = null;
        if (this.scannerPreviewMode !== 'original') {
            this.setScannerPreviewMode('original');
        } else {
            this.setScannerPreviewMode('original', { preserveTransform: true, skipValidation: true });
        }

        if (document.getElementById('ocrStudentName')) document.getElementById('ocrStudentName').value = '';
        if (document.getElementById('ocrPaperId')) document.getElementById('ocrPaperId').value = '';
        if (document.getElementById('ocrStudentCourse')) document.getElementById('ocrStudentCourse').value = '';
        if (document.getElementById('ocrStudentAge')) document.getElementById('ocrStudentAge').value = '';
        if (document.getElementById('ocrRoomNo')) document.getElementById('ocrRoomNo').value = '';
        if (document.getElementById('ocrSeatNo')) document.getElementById('ocrSeatNo').value = '';
        if (document.getElementById('ocrScore')) document.getElementById('ocrScore').value = '';
        if (document.getElementById('ocrRawText')) document.getElementById('ocrRawText').value = '';
        if (document.getElementById('ocrRawText')) document.getElementById('ocrRawText').classList.add('d-none');
        if (document.getElementById('ocrRawTextToggleBtn')) document.getElementById('ocrRawTextToggleBtn').textContent = 'Show Raw Data';
        if (document.getElementById('ocrShadedAnswers')) document.getElementById('ocrShadedAnswers').textContent = 'None';
        if (document.getElementById('ocrDebugLog')) document.getElementById('ocrDebugLog').textContent = 'No debug data yet.';
        ['ocrSex', 'ocrEntryType', 'ocrResidencyType', 'ocrEquityGroup'].forEach((id) => document.getElementById(id)?.classList.remove('is-invalid'));
        if (document.getElementById('ocrSex')) document.getElementById('ocrSex').value = '';
        if (document.getElementById('ocrEntryType')) document.getElementById('ocrEntryType').value = '';
        if (document.getElementById('ocrResidencyType')) document.getElementById('ocrResidencyType').value = '';
        if (document.getElementById('ocrEquityGroup')) document.getElementById('ocrEquityGroup').value = '';
        this.renderOCRAnswers([]);
        this.updateConfidenceAnalysis({
            scanQualityConfidence: 0.98,
            detectionCoverage: 1,
            alignmentConfidence: 0,
            templateType: null,
            templateConfidence: null,
            barcodeStatus: null
        });
        this.updateDebugPreview(null);
        this.updateScannerPipelineSummary(null);
        this.updateLastResultButtonState();

        // Reset image preview state
        this.imagePreviewScale = 1;
        this.imagePreviewTranslateX = 0;
        this.imagePreviewTranslateY = 0;
        const panel = document.getElementById('ocrImagePanel');
        if (panel) panel.classList.add('d-none');
    }

    normalizeManualAnswer(value) {
        const v = String(value || '').trim().toUpperCase();
        if (!v || v === '-' || v === '\u2014' || v === 'BLANK') return '';
        if (v === 'M' || v === 'MULTIPLE' || v === 'MULT' || v.startsWith('MULT ')) return 'MULTIPLE';
        // Support A-F for broader exam formats
        if (/^[A-F]$/.test(v)) return v;
        return '';
    }

    renderImagePreview(result) {
        const wrapper = document.getElementById('ocrImageWrapper');
        const img = document.getElementById('ocrPreviewImage');
        const panel = document.getElementById('ocrImagePanel');
        if (!wrapper || !img || !panel) return;

        // Priority: original image first, avoid debug overlays for main preview
        let imageUrl =
            result.originalImageUrl ||
            result.originalImagePath ||
            result.uploadedImagePath ||
            result.scanImagePath ||
            result.imagePath ||
            result.image_path ||
            result.photo ||
            this.selectedScanImage ||
            null;

        if (!imageUrl) {
            panel.classList.add('d-none');
            return;
        }

        if (typeof imageUrl === 'string' && imageUrl.startsWith('/')) {
            imageUrl = scanCheckConfig.resolveUrl(imageUrl);
        }

        // Reset transform state for new image
        this.imagePreviewScale = 1;
        this.imagePreviewTranslateX = 0;
        this.imagePreviewTranslateY = 0;
        img.style.transform = '';

        // Immediately show the panel and a loading state if needed
        panel.classList.remove('d-none');
        img.classList.add('opacity-50');

        img.onload = () => {
            img.classList.remove('opacity-50');
            // Calculate fit scale: fit to width or height depending on aspect ratio
            const wrapperWidth = wrapper.clientWidth || 300;
            const wrapperHeight = wrapper.clientHeight || 300;
            const fitScale = Math.min(wrapperWidth / img.naturalWidth, wrapperHeight / img.naturalHeight);
            
            // Set initial scale to fit exactly, then allow dragging
            this.imagePreviewScale = fitScale;
            this.imagePreviewTranslateX = 0;
            this.imagePreviewTranslateY = 0;
            this.applyImageTransform();
        };

        img.onerror = () => {
            console.error('Failed to load preview image:', imageUrl);
            panel.classList.add('d-none');
        };

        img.src = imageUrl;
        this.initImageDrag();
        
        // Add a "View Debug" button if debug image exists
        this.renderDebugToggleButton(result);
    }

    renderDebugToggleButton(result) {
        const toolbar = document.querySelector('.ocr-image-toolbar');
        if (!toolbar) return;

        // Remove existing debug toggle if any
        const existing = document.getElementById('ocrDebugImageToggle');
        if (existing) existing.remove();

        const debugUrl = result.debugImagePath || result.warpedDebugImagePath || result.debugImageUrl;
        if (!debugUrl) return;

        const btn = document.createElement('button');
        btn.id = 'ocrDebugImageToggle';
        btn.className = 'btn btn-sm btn-warning opacity-75';
        btn.title = 'Toggle Debug Overlay';
        btn.innerHTML = '<i class="fas fa-bug"></i>';
        
        let showingDebug = false;
        const originalSrc = document.getElementById('ocrPreviewImage').src;
        const resolvedDebugUrl = debugUrl.startsWith('/') ? scanCheckConfig.resolveUrl(debugUrl) : debugUrl;

        btn.onclick = () => {
            showingDebug = !showingDebug;
            const img = document.getElementById('ocrPreviewImage');
            img.src = showingDebug ? resolvedDebugUrl : originalSrc;
            btn.classList.toggle('btn-warning', !showingDebug);
            btn.classList.toggle('btn-danger', showingDebug);
        };

        toolbar.prepend(btn);
    }

    applyImageTransform() {
        const img = document.getElementById('ocrPreviewImage');
        const level = document.getElementById('ocrZoomLevel');
        if (!img) return;
        img.style.transform = `translate(${this.imagePreviewTranslateX}px, ${this.imagePreviewTranslateY}px) scale(${this.imagePreviewScale})`;
        if (level) level.textContent = `${Math.round(this.imagePreviewScale * 100)}%`;
    }

    zoomIn() {
        this.imagePreviewScale *= 1.25;
        this.applyImageTransform();
    }

    zoomOut() {
        this.imagePreviewScale /= 1.25;
        this.applyImageTransform();
    }

    zoomReset() {
        const wrapper = document.getElementById('ocrImageWrapper');
        const img = document.getElementById('ocrPreviewImage');
        if (!wrapper || !img || !img.naturalWidth) {
            this.imagePreviewScale = 1;
            this.imagePreviewTranslateX = 0;
            this.imagePreviewTranslateY = 0;
            this.applyImageTransform();
            return;
        }
        const fitScale = wrapper.clientWidth / img.naturalWidth;
        this.imagePreviewScale = Math.min(1, fitScale);
        this.imagePreviewTranslateX = 0;
        this.imagePreviewTranslateY = 0;
        this.applyImageTransform();
    }

    initImageDrag() {
        const wrapper = document.getElementById('ocrImageWrapper');
        if (!wrapper) return;

        this.destroyImageDrag();

        const self = this;
        wrapper.onmousedown = function (e) {
            if (e.button !== 0) return;
            self.imagePreviewDragging = true;
            self.imagePreviewDragStartX = e.clientX - self.imagePreviewTranslateX;
            self.imagePreviewDragStartY = e.clientY - self.imagePreviewTranslateY;
            wrapper.style.cursor = 'grabbing';
        };

        wrapper.onmousemove = function (e) {
            if (!self.imagePreviewDragging) return;
            self.imagePreviewTranslateX = e.clientX - self.imagePreviewDragStartX;
            self.imagePreviewTranslateY = e.clientY - self.imagePreviewDragStartY;
            self.applyImageTransform();
        };

        wrapper.onmouseup = function () {
            self.imagePreviewDragging = false;
            wrapper.style.cursor = 'grab';
        };

        wrapper.onmouseleave = function () {
            self.imagePreviewDragging = false;
            wrapper.style.cursor = 'grab';
        };

        wrapper.ontouchstart = function (e) {
            const touch = e.touches[0];
            if (!touch) return;
            self.imagePreviewDragging = true;
            self.imagePreviewDragStartX = touch.clientX - self.imagePreviewTranslateX;
            self.imagePreviewDragStartY = touch.clientY - self.imagePreviewTranslateY;
        };

        wrapper.ontouchmove = function (e) {
            if (!self.imagePreviewDragging) return;
            e.preventDefault();
            const touch = e.touches[0];
            if (!touch) return;
            self.imagePreviewTranslateX = touch.clientX - self.imagePreviewDragStartX;
            self.imagePreviewTranslateY = touch.clientY - self.imagePreviewDragStartY;
            self.applyImageTransform();
        };

        wrapper.ontouchend = function () {
            self.imagePreviewDragging = false;
        };

        wrapper.onwheel = function (e) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            self.imagePreviewScale *= delta;
            self.imagePreviewScale = Math.max(0.1, Math.min(20, self.imagePreviewScale));
            self.applyImageTransform();
        };
    }

    destroyImageDrag() {
        const wrapper = document.getElementById('ocrImageWrapper');
        if (!wrapper) return;
        wrapper.onmousedown = null;
        wrapper.onmousemove = null;
        wrapper.onmouseup = null;
        wrapper.onmouseleave = null;
        wrapper.ontouchstart = null;
        wrapper.ontouchmove = null;
        wrapper.ontouchend = null;
        wrapper.onwheel = null;
    }

    onAnswerEdit(input, index) {
        const original = this.normalizeManualAnswer(input.dataset.original || '');
        const current = this.normalizeManualAnswer(input.value);
        const box = input.closest('.ocr-answer-box');
        if (!box) return;

        const isEdited = current !== original;
        const existingBadge = box.querySelector('.edited-badge');

        if (isEdited) {
            box.classList.add('edited');
            if (!existingBadge) {
                const badge = document.createElement('span');
                badge.className = 'edited-badge badge bg-warning text-dark ms-1';
                badge.textContent = 'Edited';
                const titleDiv = box.querySelector('.small.text-muted');
                if (titleDiv) titleDiv.appendChild(badge);
            }
        } else {
            box.classList.remove('edited');
            if (existingBadge) existingBadge.remove();
        }

        if (current === 'MULTIPLE') {
            input.classList.add('multival');
        } else {
            input.classList.remove('multival');
        }

        this.recalculateScore();
    }

    recalculateScore() {
        const result = this.currentOcrResult;
        if (!result) return;

        const inputs = document.querySelectorAll('.ocr-answer-input');
        const currentAnswers = Array.from(inputs).map(i => this.normalizeManualAnswer(i.value));
        const correctAnswers = result.correctAnswers || [];

        let score = 0;
        currentAnswers.forEach((ans, idx) => {
            const key = (correctAnswers[idx] || '').toUpperCase();
            if (key && ans === key) score++;
        });

        const scoreEl = document.getElementById('ocrScore');
        if (scoreEl) scoreEl.value = score;

        // Update correct/wrong icons in-place
        const boxes = document.querySelectorAll('.ocr-answer-box');
        boxes.forEach((box, idx) => {
            const ans = currentAnswers[idx];
            const key = (correctAnswers[idx] || '').toUpperCase();
            const iconContainer = box.querySelector('.small.text-muted');
            if (!iconContainer) return;

            const oldIcon = iconContainer.querySelector('.feedback-icon');
            if (key && ans !== undefined) {
                const isCorrect = ans && ans === key;
                const icon = document.createElement('i');
                icon.className = `feedback-icon fas fa-${isCorrect ? 'check-circle text-success' : 'times-circle text-danger'} ms-1 small`;
                icon.title = `Key: ${key}`;
                if (oldIcon) oldIcon.replaceWith(icon);
                else iconContainer.appendChild(icon);
            } else if (oldIcon) {
                oldIcon.remove();
            }
        });

        // Update scan summary counts
        const detectedEl = document.getElementById('ocrDetectedCount');
        const reviewEl = document.getElementById('ocrReviewCount');
        if (detectedEl) {
            const detected = currentAnswers.filter(a => a && a !== 'MULTIPLE').length;
            const multiple = currentAnswers.filter(a => a === 'MULTIPLE').length;
            const blank = currentAnswers.filter(a => !a).length;
            detectedEl.textContent = detected;
            if (reviewEl) reviewEl.textContent = blank + multiple;
        }
    }

    clearScannerImage() {
        this.selectedScanImage = null;
        this.selectedScanImages = [];
        this.bulkScanResults = [];
        this.isBulkScanning = false;
        this.selectedReceivedPaperId = null;
        this.currentOcrResult = null;
        this.detectedScannerLayout = null;
        this.scannerPreviewMode = 'original';
        this.scannerOriginalPreviewImage = null;
        this.scannerAiInputPreviewImage = null;
        this.imageRotation = 0;
        this.imageZoom = 1;
        this.imagePanX = 0;
        this.imagePanY = 0;
        this.scannerImageDragging = false;

        const preview = document.getElementById('scannerImagePreview');
        if (preview) {
            preview.innerHTML = `
                <div class="preview-placeholder text-center">
                    <i class="fas fa-file-invoice fa-4x text-muted mb-3 opacity-50"></i>
                    <h5 class="text-muted fw-bold">Upload OMR Sheet</h5>
                    <p class="small text-muted mb-0">Use the upload button above to get started</p>
                </div>
            `;
            preview.classList.add('border-dashed');
        }

        const controls = document.getElementById('scannerImageControls');
        if (controls) controls.classList.add('d-none');
        const zoomLevel = document.getElementById('scannerZoomLevel');
        if (zoomLevel) zoomLevel.textContent = '100%';

        const input = document.getElementById('scannerImageInput');
        if (input) input.value = '';
        this.renderScannerLayoutDetection(null, 'idle');
        this.setScannerAiStatus('ready');
        this.setScannerPreviewMode('original');
        if (document.getElementById('scannerStudentName')) document.getElementById('scannerStudentName').value = '';
        if (document.getElementById('scannerStudentCourse')) document.getElementById('scannerStudentCourse').value = '';
        if (document.getElementById('scannerStudentAge')) document.getElementById('scannerStudentAge').value = '';
        if (document.getElementById('scannerRoomNo')) document.getElementById('scannerRoomNo').value = '';
        if (document.getElementById('scannerSeatNo')) document.getElementById('scannerSeatNo').value = '';
        if (document.getElementById('scannerEntryType')) document.getElementById('scannerEntryType').value = '';
        if (document.getElementById('scannerEquityGroup')) document.getElementById('scannerEquityGroup').value = '';

        this.updateScannerScanButtonState();
        this.renderBulkScanQueue();
        this.updateLastResultButtonState();
        this.updateScannerPipelineSummary(null);
    }

    resetOcrModalState() {
        this.currentOcrResult = null;

        if (document.getElementById('ocrStudentName')) document.getElementById('ocrStudentName').value = '';
        if (document.getElementById('ocrStudentCourse')) document.getElementById('ocrStudentCourse').value = '';
        if (document.getElementById('ocrStudentAge')) document.getElementById('ocrStudentAge').value = '';
        if (document.getElementById('ocrRoomNo')) document.getElementById('ocrRoomNo').value = '';
        if (document.getElementById('ocrSeatNo')) document.getElementById('ocrSeatNo').value = '';
        if (document.getElementById('ocrScore')) document.getElementById('ocrScore').value = '';
        if (document.getElementById('ocrRawText')) document.getElementById('ocrRawText').value = '';
        if (document.getElementById('ocrRawText')) document.getElementById('ocrRawText').classList.add('d-none');
        if (document.getElementById('ocrRawTextToggleBtn')) document.getElementById('ocrRawTextToggleBtn').textContent = 'Show Raw Data';
        if (document.getElementById('ocrShadedAnswers')) document.getElementById('ocrShadedAnswers').textContent = 'None';
        if (document.getElementById('ocrDebugLog')) document.getElementById('ocrDebugLog').textContent = 'No debug data yet.';
        ['ocrSex', 'ocrEntryType', 'ocrResidencyType', 'ocrEquityGroup'].forEach((id) => document.getElementById(id)?.classList.remove('is-invalid'));
        if (document.getElementById('ocrSex')) document.getElementById('ocrSex').value = '';
        if (document.getElementById('ocrEntryType')) document.getElementById('ocrEntryType').value = 'New Student';
        if (document.getElementById('ocrResidencyType')) document.getElementById('ocrResidencyType').value = 'Passinhon';
        if (document.getElementById('ocrEquityGroup')) document.getElementById('ocrEquityGroup').value = 'None';
        this.renderOCRAnswers([]);
        this.updateConfidenceAnalysis({
            scanQualityConfidence: 0.98,
            detectionCoverage: 1,
            alignmentConfidence: 0,
            templateType: null,
            templateConfidence: null,
            barcodeStatus: null
        });
        this.updateDebugPreview(null);
        this.applyScannerViewSettings();
        this.updateLastResultButtonState();
        this.updateScannerPipelineSummary(null);
    }

    promptNewScanImage() {
        this.clearScannerImage();
        this.resetOcrModalState();

        this.openScannerFilePicker();
    }

    scanCurrentImageAgain() {
        const modalEl = document.getElementById('ocrResultsModal');
        const modal = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
        if (modal) modal.hide();

        this.resetOcrModalState();

        if (this.selectedScanImage) {
            this.showToast('Rescanning current image...', 'info');
            this.startScannerOCR();
            return;
        }

        this.promptNewScanImage();
    }

    async startBulkScannerOCR() {
        const queue = Array.isArray(this.selectedScanImages) ? this.selectedScanImages : [];
        if (queue.length <= 1) return this.startScannerOCR();

        const quizId = document.getElementById('scannerExamSelect')?.value || null;
        if (!quizId) {
            this.showToast('Select a manual exam override before bulk scanning.', 'warning');
            return;
        }

        const overlay = document.getElementById('scannerOverlay');
        const progressBar = document.getElementById('bulkScanProgressBar');
        if (overlay) {
            overlay.classList.remove('d-none');
            overlay.classList.add('d-flex');
        }
        this.updateScannerStatusBadge('processing');
        this.setScannerAiStatus('processing');
        this.setScannerStage('prepare');

        this.isBulkScanning = true;
        this.updateScannerScanButtonState();
        this.bulkScanResults = [];
        queue.forEach((item) => {
            item.status = 'ready';
            item.result = null;
            item.error = '';
        });
        this.renderBulkScanQueue();

        let successCount = 0;
        const BATCH_SIZE = 20;

        for (let index = 0; index < queue.length; index += 1) {
            // Check for batch pause
            if (index > 0 && index % BATCH_SIZE === 0) {
                if (overlay) {
                    overlay.querySelector('h6').textContent = `Batch limit reached (${BATCH_SIZE}). Pausing for 5 seconds...`;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
                if (overlay) {
                    overlay.querySelector('h6').textContent = `Scanning Paper...`;
                }
            }

            const item = queue[index];
            item.status = 'running';
            this.setScannerStage('analyze');
            this.selectedScanImage = item.dataUrl;
            this.setScannerPreviewImage(item.dataUrl, item.name);
            this.renderBulkScanQueue();

            const progress = Math.round((index / queue.length) * 100);
            if (progressBar) progressBar.style.width = `${Math.max(5, progress)}%`;

            try {
                const sourceId = item.sourceReceivedPaperId || null;
                const result = await this.processScannerImageData(item.dataUrl, {
                    rotation: 0,
                    sourceReceivedPaperId: sourceId,
                    context: `bulkOCR:${item.name}`
                });

                if (result?.success) {
                    item.status = 'done';
                    // Ensure the source ID is attached to the result for saving later
                    result.sourceReceivedPaperId = sourceId;
                    item.result = result;
                    this.bulkScanResults.push(result);
                    this.currentOcrResult = result;
                    successCount += 1;
                } else {
                    item.status = 'failed';
                    item.error = result?.message || 'Invalid OMR sheet';
                }
            } catch (error) {
                console.error('Bulk OMR Error:', error);
                item.status = 'failed';
                item.error = error.message || 'Scan failed';
            }

            this.renderBulkScanQueue();
            if (progressBar) progressBar.style.width = `${Math.round(((index + 1) / queue.length) * 100)}%`;
        }

        this.isBulkScanning = false;
        this.updateScannerScanButtonState();
        this.updateLastResultButtonState();
        this.setScannerAiStatus('ready');
        this.updateScannerStatusBadge(successCount > 0 ? 'complete' : 'failed');

        setTimeout(() => {
            if (overlay) {
                overlay.classList.add('d-none');
                overlay.classList.remove('d-flex');
            }
            if (progressBar) progressBar.style.width = '0%';
        }, 500);

        const failedCount = queue.length - successCount;
        if (successCount > 0) {
            this.showToast(`Bulk scan complete: ${successCount} processed, ${failedCount} failed. Open each result to review and save.`, failedCount ? 'warning' : 'success');
        } else {
            this.showToast('Bulk scan finished, but no papers were accepted.', 'danger');
        }
    }

    async startScannerOCR() {
        this.clearCurrentOcrResultOnly();

        if (Array.isArray(this.selectedScanImages) && this.selectedScanImages.length > 1) {
            await this.startBulkScannerOCR();
            return;
        }

        if (!this.selectedScanImage) {
            this.showToast('Please select or upload an image first', 'warning');
            return;
        }

        const context = this.scannerSelectedQuizContext();
        if (!this.detectedScannerLayout?.layoutId && !context.quizId) {
            this.showToast('Could not identify sheet layout. Select the target exam manually.', 'warning');
            return;
        }

        const overlay = document.getElementById('scannerOverlay');
        if (overlay) {
            overlay.classList.remove('d-none');
            overlay.classList.add('d-flex');
        }
        this.updateScannerStatusBadge('processing');
        this.setScannerAiStatus('processing');
        this.setScannerStage('prepare');

        try {
            this.setScannerStage('layout');
            if (!this.detectedScannerLayout?.layoutId) {
                await this.identifyScannerLayout(this.selectedScanImage);
            }
            this.setScannerStage('analyze');
            const result = await this.processScannerImageData(this.selectedScanImage, {
                rotation: this.imageRotation,
                sourceReceivedPaperId: this.selectedReceivedPaperId,
                context: 'processOCR'
            });
            this.setScannerStage('validate');

            if (result.success) {
                this.currentOcrResult = result;
                this.scannerAiInputPreviewImage = result.aiInputPreview || result.templateMetrics?.aiInputPreview || result.metrics?.aiInputPreview || null;
                console.log(`[OCR Response] requestId=${result.requestId} hash=${(result.imageHash || '').slice(0, 12)} debugPath=${result.debugImagePath || ''}`);
                
                this.updateLastResultButtonState();
                this.updateScannerPipelineSummary(result);
                
                // Auto-fill Scanner Student Information (Optional) on main workspace
                const qr = result.barcodeData || {};
                const firstNonEmpty = (...values) => {
                    for (const value of values) {
                        const text = String(value ?? '').trim();
                        if (text) return text;
                    }
                    return '';
                };
                if (document.getElementById('scannerStudentName')) document.getElementById('scannerStudentName').value = firstNonEmpty(result.studentName, result.student_name, qr.studentName, qr.student_name, qr.name);
                if (document.getElementById('scannerStudentCourse')) document.getElementById('scannerStudentCourse').value = firstNonEmpty(result.course, qr.course);
                if (document.getElementById('scannerStudentAge')) document.getElementById('scannerStudentAge').value = firstNonEmpty(result.age, qr.age);
                if (document.getElementById('scannerRoomNo')) document.getElementById('scannerRoomNo').value = firstNonEmpty(result.roomNo, result.room_no, qr.roomNo, qr.room_no, qr.room);
                if (document.getElementById('scannerSeatNo')) document.getElementById('scannerSeatNo').value = firstNonEmpty(result.seatNo, result.seat_no, qr.seatNo, qr.seat_no, qr.seat);
                if (document.getElementById('scannerEntryType')) {
                    const eg = result.entryGroup || {};
                    document.getElementById('scannerEntryType').value = eg.studentType || result.entryType || '';
                }
                if (document.getElementById('scannerEquityGroup') && result.equityGroup) document.getElementById('scannerEquityGroup').value = result.equityGroup;

                // Present result in modal
                this.setScannerPreviewMode('results');
                this.presentOcrResult(result, { showModal: true });
                return;
            }

            // Check if failure was due to missing layout
            if (!result.layoutFound || result.requiresLayout) {
                const layoutId = result.layoutId || result.examId || 'unknown';
                this.showToast(
                    `Layout ${layoutId} was not found. This sheet cannot be scanned on this computer unless the matching layout JSON is restored. Generate a new answer sheet and scan the new one.`,
                    'danger',
                    8000
                );
                this.setSystemBackupLog(
                    `Scan failed: Layout ${layoutId} not found. Regenerate the answer sheet on this computer.`,
                    true
                );
            } else {
                this.showToast('The uploaded image could not be processed.', 'danger');
            }
        } catch (error) {
            console.error('AI Vision scan error:', error);
            this.updateScannerStatusBadge('failed');
            this.showToast(this.friendlyScanError(error), 'danger');
        } finally {
            this.setScannerAiStatus('ready');
            if (overlay) {
                overlay.classList.add('d-none');
                overlay.classList.remove('d-flex');
            }
        }
    }

    renderOCRAnswers(answers, confidence = {}, correctAnswers = [], questionMetrics = []) {
        const container = document.getElementById('ocrAnswersList');
        if (!container) return;

        if (!answers || answers.length === 0) {
            container.innerHTML = `
                <div class="empty-state py-5">
                    <i class="fas fa-search empty-state-icon"></i>
                    <h6 class="empty-state-title">No answers detected</h6>
                    <p class="empty-state-description small">AI Vision did not return any answer records for this scan.</p>
                </div>
            `;
            return;
        }

        const metricByQuestion = new Map(
            (Array.isArray(questionMetrics) ? questionMetrics : [])
                .map((item) => [Number(item?.questionNumber ?? item?.question), item])
                .filter(([qNum]) => Number.isFinite(qNum) && qNum > 0)
        );

        const visibleEntries = (Array.isArray(answers) ? answers : [])
            .map((ans, i) => {
                const metric = metricByQuestion.get(i + 1) || null;
                const state = String(metric?.state || '').trim().toLowerCase();
                if (state === 'ignored') return null;
                return {
                    answer: ans,
                    originalIndex: i,
                    metric,
                    displayQuestionNumber: Number(metric?.displayQuestionNumber) > 0
                        ? Number(metric.displayQuestionNumber)
                        : null
                };
            })
            .filter(Boolean);

        container.innerHTML = `
            <div class="row row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-lg-5 g-3">
                ${visibleEntries.map((entry, visibleIndex) => {
                    const ans = entry.answer;
                    const i = entry.originalIndex;
                    const conf = confidence[i] || 1.0;
                    const metric = entry.metric || null;
                    const metricState = String(metric?.state || '').trim().toLowerCase();
                    const displayAnswer = formatOcrAnswerDisplay(ans, metric);
                    const displayQ = entry.displayQuestionNumber || (visibleIndex + 1);
                    const correctAns = correctAnswers[displayQ - 1] || '';
                    
                    let statusClass = 'border-primary';
                    let bgClass = 'bg-white';
                    
                    if (metricState === 'multiple') {
                        statusClass = 'border-danger shadow-sm';
                        bgClass = 'bg-danger bg-opacity-10';
                    } else if (metricState === 'uncertain' || metric?.needsReview) {
                        statusClass = 'border-warning shadow-sm';
                        bgClass = 'bg-warning bg-opacity-10';
                    } else if (metricState === 'blank' || !ans) {
                        statusClass = 'border-secondary opacity-50';
                        bgClass = 'bg-light';
                    } else if (conf < 0.8) {
                        statusClass = 'border-warning shadow-sm';
                        bgClass = 'bg-warning bg-opacity-10';
                    }

                    let feedbackIcon = '';
                    if (correctAns) {
                        const isCorrect = String(ans).trim().toUpperCase() === String(correctAns).trim().toUpperCase();
                        feedbackIcon = isCorrect ? 
                            `<i class="fas fa-check-circle text-success ms-1" title="Matches Key: ${correctAns}"></i>` : 
                            `<i class="fas fa-times-circle text-danger ms-1" title="Key: ${correctAns}"></i>`;
                    }

                    return `
                        <div class="col">
                            <div class="card h-100 border ${statusClass} ${bgClass} transition-all">
                                <div class="card-body p-2 text-center">
                                    <div class="x-small fw-bold text-muted mb-1 d-flex justify-content-center align-items-center">
                                        Q${displayQ} ${feedbackIcon}
                                    </div>
                                    <input type="text" class="form-control form-control-sm text-center fw-bold border-0 bg-transparent p-0 ocr-answer-input ${displayAnswer.className}" 
                                           style="font-size: 1.1rem;"
                                           value="${escapeHtml(displayAnswer.value)}"
                                           title="${escapeHtml(displayAnswer.title)}"
                                           data-index="${i}" 
                                           onfocus="if (this.value === '—' || this.value === 'Blank' || this.value === 'Review' || this.value.startsWith('MULT')) this.value = ''"
                                           oninput="app.onAnswerEdit(this, ${i})">
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    renderOmrDebugLog(result = {}) {
        const shadedEl = document.getElementById('ocrShadedAnswers');
        const debugEl = document.getElementById('ocrDebugLog');
        const rawTextEl = document.getElementById('ocrRawText');
        if (!shadedEl || !debugEl) return;

        const answers = Array.isArray(result.answers) ? result.answers : [];
        const questionMetrics = Array.isArray(result.questionMetrics) ? result.questionMetrics : [];
        const metricByQuestion = new Map(
            questionMetrics
                .map((item) => [Number(item?.questionNumber ?? item?.question), item])
                .filter(([qNum]) => Number.isFinite(qNum) && qNum > 0)
        );

        const activeQuestionNumbers = Array.isArray(result.activeQuestionNumbers)
            ? result.activeQuestionNumbers
                .map((value) => Number.parseInt(String(value), 10))
                .filter((value) => Number.isFinite(value) && value > 0)
            : [];
        const activeQuestionSet = new Set(activeQuestionNumbers);
        const shadedAnswers = [];
        const ambiguousAnswers = [];
        const detailLines = [];
        let activeOrdinal = 0;

        for (let i = 0; i < answers.length; i++) {
            const sourceQNum = i + 1;
            const metric = metricByQuestion.get(sourceQNum) || {};
            const metricState = String(metric.state || '').trim().toLowerCase();
            const isIgnored = metricState === 'ignored' || (activeQuestionSet.size > 0 && !activeQuestionSet.has(sourceQNum));
            if (isIgnored) continue;

            activeOrdinal += 1;
            const displayQNum = Number(metric.displayQuestionNumber) > 0 ? Number(metric.displayQuestionNumber) : activeOrdinal;
            const answer = String(answers[i] || '').trim().toUpperCase();
            const state = String(metric.state || '').trim() || 'review';
            const rawAnswer = String(metric.rawAnswer || '').trim().toUpperCase();
            const topOption = String(metric.winningOption || '').trim().toUpperCase();
            const topScore = Number(metric.topScore);
            const secondOption = String(metric.secondOption || '').trim().toUpperCase();
            const secondScore = Number(metric.secondScore);

            if (answer) {
                shadedAnswers.push(`Q${displayQNum}:${answer}`);
            }
            if (/^[A-E]{2,}$/.test(rawAnswer)) {
                ambiguousAnswers.push(`Q${displayQNum}:${rawAnswer}`);
            }

            detailLines.push(
                `Q${displayQNum.toString().padStart(3, '0')} | answer=${answer || '-'} | state=${state}` +
                `${sourceQNum !== displayQNum ? ` | sourceQ=${sourceQNum}` : ''}` +
                `${rawAnswer ? ` | raw=${rawAnswer}` : ''}` +
                `${topOption ? ` | top=${topOption}${Number.isFinite(topScore) ? `(${Math.round(topScore * 100)}%)` : ''}` : ''}` +
                `${secondOption ? ` | second=${secondOption}${Number.isFinite(secondScore) ? `(${Math.round(secondScore * 100)}%)` : ''}` : ''}`
            );
        }

        shadedEl.textContent = shadedAnswers.length > 0 ? shadedAnswers.join(', ') : 'None';

        const qr = result.barcodeData || {};
        const alignmentValue = result.alignmentConfidence;
        const coveragePct = Math.round(Number(result.detectionCoverage ?? result.overallConfidence ?? 0) * 100);
        const qualityPct = Math.round(Number(result.scanQualityConfidence ?? result.overallConfidence ?? 0) * 100);
        const alignmentText = (alignmentValue == null || alignmentValue === '')
            ? 'n/a'
            : `${Math.round(Number(alignmentValue || 0) * 100)}%`;

        const headerLines = [
            `[Scan Timestamp] ${new Date().toISOString()}`,
            `[Scan ID] ${result.requestId || '-'}`,
            `[Image Hash] ${(result.imageHash || '-').slice(0, 12)}`,
            `[Debug Image] ${result.debugImagePath || '-'}`,
            `[Worker Started] ${result.workerStartedAt || '-'}`,
            `[Engine] ${result.workerUsed || result.omrEngineUsed || '-'}`,
            `[Scan Mode] ${result.scanMode || '-'}`,
            `[Layout] found=${Object.prototype.hasOwnProperty.call(result, 'layoutFound') ? Boolean(result.layoutFound) : '-'} | id=${result.layoutId || result.examId || '-'}`,
            `[Quality] scan=${qualityPct}% alignment=${alignmentText}`,
            `[Coverage] detected=${shadedAnswers.length}/${Math.max(activeOrdinal, Number(result.activeQuestionCount || 0))} (${coveragePct}%)`,
            `[QR Status] ${result.barcodeStatus || 'none'}`,
            `[QR Data] sheetId=${qr.sheetId || qr.sheet_id || '-'} | examId=${qr.examId || qr.exam_id || '-'}`,
            `[Bubble Fields] entryType=${result.entryType || '-'} | equityGroup=${result.equityGroup || '-'}`,
            `[Summary] scanned=${shadedAnswers.length}/${Math.max(activeOrdinal, Number(result.activeQuestionCount || 0))} | ambiguous=${ambiguousAnswers.length}`
        ];

        if (result.falsePositiveSuppressed) {
            headerLines.push(`[Guard] false-positive suppression active (${result.falsePositiveSuppressionReason || 'heuristic'})`);
        }
        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
            headerLines.push(`[Warnings] ${result.warnings.join(' | ')}`);
        }

        if (ambiguousAnswers.length > 0) {
            headerLines.push(`[Ambiguous] ${ambiguousAnswers.join(', ')}`);
        }

        const fullLog = [...headerLines, '', '[Per Question Detail]', ...detailLines].join('\n');
        debugEl.textContent = fullLog;

        if (rawTextEl) {
            rawTextEl.value = fullLog;
        }
    }

    updateConfidenceAnalysis(resultOrConfidence, alignmentConfidence = 0) {
        const qualityBadge = document.getElementById('ocrQualityBadge');
        const coverageBadge = document.getElementById('ocrCoverageBadge');
        const warning = document.getElementById('ocrAlignmentWarning');
        const qrBadge = document.getElementById('qrStatusBadge');
        
        if (!qualityBadge || !coverageBadge) return;

        const payload = (resultOrConfidence && typeof resultOrConfidence === 'object')
            ? resultOrConfidence
            : {
                scanQualityConfidence: Number(resultOrConfidence || 0),
                detectionCoverage: Number(resultOrConfidence || 0),
                alignmentConfidence
            };

        const quality = Number(payload.scanQualityConfidence ?? payload.overallConfidence ?? 0);
        const totalQuestions = Number(payload.activeQuestionCount || 0) || (Array.isArray(payload.answers) ? payload.answers.length : 0);
        const scannedCount = Number(payload.scannedCount) || (Array.isArray(payload.answers)
            ? payload.answers.filter((value) => String(value || '').trim()).length
            : 0);

        const pct = Math.round(quality * 100);
        const coveragePct = totalQuestions > 0 ? Math.round((scannedCount / totalQuestions) * 100) : Math.round(Number(payload.detectionCoverage ?? 0) * 100);
        
        let colorClass = 'bg-success';
        if (pct < 70) colorClass = 'bg-danger';
        else if (pct < 90) colorClass = 'bg-warning text-dark';

        qualityBadge.textContent = `${pct}%`;
        qualityBadge.className = `badge ${colorClass}`;

        coverageBadge.textContent = `${coveragePct}%`;
        coverageBadge.className = `badge bg-primary`;

        if (qrBadge) {
            const qrStatus = payload.barcodeStatus;
            if (qrStatus === 'qr_success' || qrStatus === 'success') {
                qrBadge.innerHTML = '<span class="badge bg-success bg-opacity-10 text-success border border-success border-opacity-25 px-2 py-1 rounded-pill"><i class="fas fa-qrcode me-1"></i> QR Verified</span>';
            } else {
                qrBadge.innerHTML = '<span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary border-opacity-25 px-2 py-1 rounded-pill"><i class="fas fa-list-check me-1"></i> Selected Layout</span>';
            }
        }

        if (warning) {
            const alignValue = Number(payload.alignmentConfidence ?? 0);
            if (alignValue > 0 && alignValue < 0.75) {
                warning.classList.remove('d-none');
                warning.textContent = `Alignment quality is low (${Math.round(alignValue * 100)}%). Review yellow answers.`;
            } else {
                warning.classList.add('d-none');
            }
        }
    }

    updateDebugPreview(debugImagePath) {
        const wrapper = document.getElementById('ocrDebugPreview');
        const link = document.getElementById('ocrDebugPreviewLink');
        if (!wrapper || !link) return;

        if (debugImagePath) {
            wrapper.classList.remove('d-none');
            link.href = debugImagePath;
        } else {
            wrapper.classList.add('d-none');
            link.href = '#';
        }
    }

    toggleRawText() {
        const txt = document.getElementById('ocrRawText');
        const toggleBtn = document.getElementById('ocrRawTextToggleBtn');
        if (!txt) return;

        txt.classList.toggle('d-none');
        if (toggleBtn) {
            toggleBtn.textContent = txt.classList.contains('d-none') ? 'Show Raw Data' : 'Hide Raw Data';
        }
    }

    async saveOCRToRecords() {
        const quizId = document.getElementById('scannerExamSelect')?.value || null;
        if (!quizId) {
            this.showToast('Select a target exam before saving to records', 'warning');
            return;
        }
        const studentName = document.getElementById('ocrStudentName')?.value || '';
        const paperId = document.getElementById('ocrPaperId')?.value || '';
        const course = document.getElementById('ocrStudentCourse')?.value || '';
        const age = document.getElementById('ocrStudentAge')?.value || '';
        const roomNo = document.getElementById('ocrRoomNo')?.value || '';
        const seatNo = document.getElementById('ocrSeatNo')?.value || '';
        const entryType = document.getElementById('ocrEntryType')?.value || '';
        const residencyType = document.getElementById('ocrResidencyType')?.value || '';
        const equityGroup = document.getElementById('ocrEquityGroup')?.value || '';
        const examDateTime = document.getElementById('ocrDateTime')?.value || '';
        const score = document.getElementById('ocrScore')?.value || '';
        const rawText = document.getElementById('ocrRawText')?.value || '';

        if (!studentName) {
            this.showToast('Student Name is required', 'warning');
            return;
        }

        const answerInputs = document.querySelectorAll('.ocr-answer-input');
        const answers = Array.from(answerInputs).map(input => this.normalizeManualAnswer(input.value));

        try {
            await this.apiCallWithAuth('/api/records/ocr', {
                method: 'POST',
                body: JSON.stringify({
                    quiz_id: quizId,
                    student_name: studentName,
                    sheet_id: paperId,
                    course,
                    subject: '',
                    section: '',
                    age,
                    room_no: roomNo,
                    seat_no: seatNo,
                    entry_type: entryType,
                    residency_type: residencyType,
                    special_equity_group: equityGroup,
                    exam_date_time: examDateTime,
                    score: score,
                    answers,
                    raw_text: rawText,
                    image_path: this.currentOcrResult?.imagePath || this.selectedScanImage,
                    source_received_paper_id: this.currentOcrResult?.sourceReceivedPaperId || this.selectedReceivedPaperId || null
                })
            }, 'saveOCRResults');

            toastManager.showSuccess('Record saved successfully!');
            const modalEl = document.getElementById('ocrResultsModal');
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();

            this.currentOcrResult = null;
            this.selectedReceivedPaperId = null;

            // Edit Record Image State
            this.editImageRotation = 0;
            this.editImageScale = 1;
            this.editImageTranslateX = 0;
            this.editImageTranslateY = 0;
            this.editImageDragging = false;
            
            // Clear filters so the new record is visible
            const searchInput = document.getElementById('recordsSearch');
            const quizFilter = document.getElementById('recordsQuizFilter');
            const entryFilter = document.getElementById('recordsEntryFilter');
            const equityFilter = document.getElementById('recordsEquityFilter');
            const statusFilter = document.getElementById('recordsStatusFilter');
            
            if (searchInput) searchInput.value = '';
            if (quizFilter) quizFilter.value = '';
            if (entryFilter) entryFilter.value = '';
            if (equityFilter) equityFilter.value = '';
            if (statusFilter) statusFilter.value = '';

            await this.loadReceivedPapers();
            await this.loadRecords();
            await this.loadScanResults();
            await this.refreshReports();
            this.renderDashboard();
            location.hash = '#/records';
        } catch (error) {
            // Error already handled by apiCallWithAuth
        }
    }

    zoomEditImage(factor) {
        this.editImageScale *= factor;
        this.editImageScale = Math.max(0.05, Math.min(5, this.editImageScale));
        this.applyEditImageTransform();
    }

    resetEditImage() {
        const wrapper = document.getElementById('editRecordImageWrapper');
        const img = document.getElementById('editRecordImagePreview');
        if (!wrapper || !img) return;

        // Reset rotation and translations
        this.editImageRotation = 0;
        this.editImageTranslateX = 0;
        this.editImageTranslateY = 0;

        // Use a slight delay to ensure the modal layout is finished and dimensions are accurate
        setTimeout(() => {
            const wrapperWidth = wrapper.clientWidth || 300;
            const wrapperHeight = wrapper.clientHeight || 450;
            const naturalWidth = img.naturalWidth || 800;
            const naturalHeight = img.naturalHeight || 1100;

            if (naturalWidth > 0 && naturalHeight > 0) {
                const fitScale = Math.min(wrapperWidth / naturalWidth, wrapperHeight / naturalHeight);
                this.editImageScale = fitScale * 0.95; 
                this.applyEditImageTransform();
            } else {
                // Fallback if image not fully ready
                this.editImageScale = 0.3;
                this.applyEditImageTransform();
            }
        }, 50);
    }

    applyEditImageTransform() {
        const img = document.getElementById('editRecordImagePreview');
        const level = document.getElementById('editRecordZoomLevel');
        if (!img) return;
        img.style.transform = `translate(${this.editImageTranslateX}px, ${this.editImageTranslateY}px) rotate(${this.editImageRotation}deg) scale(${this.editImageScale})`;
        if (level) level.textContent = `${Math.round(this.editImageScale * 100)}%`;
    }

    initEditImagePanning() {
        const wrapper = document.getElementById('editRecordImageWrapper');
        if (!wrapper) return;

        const self = this;
        wrapper.onmousedown = (e) => {
            if (e.button !== 0) return;
            self.editImageDragging = true;
            self.editImageDragStartX = e.clientX - self.editImageTranslateX;
            self.editImageDragStartY = e.clientY - self.editImageTranslateY;
            wrapper.style.cursor = 'grabbing';
            e.preventDefault();
        };

        window.onmousemove = (e) => {
            if (!self.editImageDragging) return;
            self.editImageTranslateX = e.clientX - self.editImageDragStartX;
            self.editImageTranslateY = e.clientY - self.editImageDragStartY;
            self.applyEditImageTransform();
        };

        window.onmouseup = () => {
            if (self.editImageDragging) {
                self.editImageDragging = false;
                wrapper.style.cursor = 'grab';
            }
        };

        // Wheel zoom
        wrapper.onwheel = (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            self.zoomEditImage(delta);
        };
    }

    editRecord(recordId) {
        const record = this.records.find(r => r.id === recordId);
        if (!record) return;

        document.getElementById('editRecordId').value = record.id;
        document.getElementById('editStudentName').value = record.student_name || '';
        document.getElementById('editStudentId').value = record.sheet_id || '';
        document.getElementById('editCourse').value = record.course || '';
        document.getElementById('editAge').value = record.age || '';
        document.getElementById('editRoomNo').value = record.room_no || '';
        document.getElementById('editSeatNo').value = record.seat_no || '';
        document.getElementById('editScore').value = record.score || 0;
        document.getElementById('editExamDateTime').value = record.exam_date_time || '';
        document.getElementById('editEntryType').value = record.entry_type || 'New Student';
        document.getElementById('editResidencyType').value = record.residency_type || 'Passinhon';
        document.getElementById('editEquityGroup').value = record.special_equity_group || 'None';

        // Image Preview
        const imgPreview = document.getElementById('editRecordImagePreview');
        if (imgPreview) {
            const imageUrl = record.image_path ? (record.image_path.startsWith('data:') ? record.image_path : `/api${record.image_path}`) : '';
            imgPreview.onload = () => {
                this.resetEditImage();
                this.initEditImagePanning();
            };
            imgPreview.src = imageUrl;
        }

        // Populate Answer Grid
        const grid = document.getElementById('editRecordAnswersGrid');
        if (grid) {
            let answers = [];
            try {
                answers = typeof record.answers === 'string' ? JSON.parse(record.answers) : (record.answers || []);
            } catch (e) {
                console.error('Failed to parse answers for editing', e);
            }

            // Ensure we have 100 slots if it's a 100-q exam, or at least enough for the current answers
            const qCount = Math.max(100, answers.length);
            grid.innerHTML = '';
            
            for (let i = 0; i < qCount; i++) {
                const ans = (answers[i] || '').trim().toUpperCase();
                const col = document.createElement('div');
                col.className = 'col';
                col.innerHTML = `
                    <div class="input-group input-group-sm">
                        <span class="input-group-text bg-white border-0 text-muted x-small fw-bold" style="width: 28px; padding: 0;">${i + 1}</span>
                        <input type="text" class="form-control border-0 bg-white text-center fw-bold edit-record-answer-input" 
                               value="${ans}" maxlength="1" placeholder="-" 
                               data-index="${i}"
                               oninput="this.value = this.value.toUpperCase(); app.recalculateEditScore()">
                    </div>
                `;
                grid.appendChild(col);
            }
        }
        
        const modalEl = document.getElementById('editRecordModal');
        const modal = new bootstrap.Modal(modalEl);
        modal.show();
    }

    recalculateEditScore() {
        const inputs = document.querySelectorAll('.edit-record-answer-input');
        const scoreInput = document.getElementById('editScore');
        const id = document.getElementById('editRecordId').value;
        const record = this.records.find(r => String(r.id) === String(id));
        
        if (!record || !scoreInput) return;

        // Note: Real-time score calculation requires the correct answer key
        // If we don't have it locally, we'll just let the user manually update the score field or
        // handle it on the server. For now, let's keep the manual score field editable.
    }

    async handleEditRecordSubmit() {
        const id = document.getElementById('editRecordId').value;
        
        // Collect manual answers
        const answerInputs = document.querySelectorAll('.edit-record-answer-input');
        const answers = Array.from(answerInputs).sort((a, b) => 
            Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index'))
        ).map(input => input.value.trim().toUpperCase());

        const body = {
            studentName: document.getElementById('editStudentName').value,
            sheetId: document.getElementById('editStudentId').value,
            course: document.getElementById('editCourse').value,
            subject: '',
            section: '',
            age: document.getElementById('editAge').value,
            roomNo: document.getElementById('editRoomNo').value,
            seatNo: document.getElementById('editSeatNo').value,
            score: document.getElementById('editScore').value,
            examDateTime: document.getElementById('editExamDateTime').value,
            entryType: document.getElementById('editEntryType').value,
            residencyType: document.getElementById('editResidencyType').value,
            specialEquityGroup: document.getElementById('editEquityGroup').value,
            answers: answers,
            reviewStatus: 'manually_corrected'
        };

        try {
            await this.apiCallWithAuth(`/api/records/${id}`, {
                method: 'PUT',
                body: JSON.stringify(body)
            }, 'updateRecord');

            toastManager.showSuccess('Record updated successfully!');
            const modalEl = document.getElementById('editRecordModal');
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
            
            await this.loadRecords();
            await this.loadScanResults();
            await this.refreshReports();
            this.renderDashboard();
        } catch (error) {
            this.showToast('Update failed: ' + error.message, 'danger');
        }
    }

    async deleteRecord(recordId) {
        if (!confirm('Are you sure you want to delete this record?')) {
            return;
        }

        try {
            await this.apiCallWithAuth(`/api/records/${recordId}`, {
                method: 'DELETE'
            }, 'deleteRecord');
            
            toastManager.showSuccess('Record deleted successfully');
            await this.refreshRecordDependentViews();
        } catch (error) {
            // Error already handled
        }
    }

    populateBarcodePage() {
        this.ensureGeneratedQrMetadata();
        this.updateGeneratedSheetMeta();
    }

    openStudentExcelImport() {
        document.getElementById('qrExcelImportInput')?.click();
    }

    setStudentImportStatus(message, tone = 'muted') {
        const status = document.getElementById('qrExcelImportStatus');
        if (!status) return;
        status.className = `small text-${tone} mb-2`;
        status.textContent = message || 'No imported student list.';
    }

    normalizeExcelCellValue(value) {
        if (value == null) return '';
        if (value instanceof Date) {
            const offset = value.getTimezoneOffset() * 60000;
            return new Date(value.getTime() - offset).toISOString().slice(0, 16);
        }
        if (typeof value === 'object') {
            if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('').trim();
            if (value.text != null) return String(value.text).trim();
            if (value.result != null) return this.normalizeExcelCellValue(value.result);
            if (value.hyperlink != null && value.text != null) return String(value.text).trim();
            if (value.formula != null && value.result == null) return '';
        }
        return String(value).trim();
    }

    normalizeExcelHeader(value) {
        return this.normalizeExcelCellValue(value)
            .toLowerCase()
            .replace(/[_/&.-]+/g, ' ')
            .replace(/[^a-z0-9 ]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    mapStudentImportHeaders(headers) {
        const aliases = {
            studentName: ['full name', 'name', 'student name'],
            age: ['age'],
            course: ['course', 'program', 'department'],
            roomNo: ['room no', 'room', 'room number'],
            seatNo: ['seat no', 'seat', 'seat number'],
            dateTime: ['date time', 'date', 'time', 'datetime']
        };
        const normalized = headers.map((header) => this.normalizeExcelHeader(header));
        const mapped = {};
        Object.entries(aliases).forEach(([key, names]) => {
            mapped[key] = normalized.findIndex((header) => names.includes(header));
        });
        return mapped;
    }

    parseStudentCsv(text) {
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < text.length; i += 1) {
            const char = text[i];
            const next = text[i + 1];
            if (char === '"' && quoted && next === '"') {
                cell += '"';
                i += 1;
            } else if (char === '"') {
                quoted = !quoted;
            } else if (char === ',' && !quoted) {
                row.push(cell.trim());
                cell = '';
            } else if ((char === '\n' || char === '\r') && !quoted) {
                if (char === '\r' && next === '\n') i += 1;
                row.push(cell.trim());
                if (row.some((value) => value !== '')) rows.push(row);
                row = [];
                cell = '';
            } else {
                cell += char;
            }
        }
        row.push(cell.trim());
        if (row.some((value) => value !== '')) rows.push(row);
        return rows;
    }

    async readStudentImportRows(file) {
        const name = String(file?.name || '').toLowerCase();
        if (name.endsWith('.csv')) {
            const text = await file.text();
            return this.parseStudentCsv(text).map((cells, index) => ({ rowNumber: index + 1, cells }));
        }
        if (!window.ExcelJS) {
            throw new Error('Excel parser is unavailable. Connect to the internet once or import a CSV file.');
        }
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await file.arrayBuffer());
        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new Error('No worksheet found in the imported file.');
        const maxColumn = Math.max(worksheet.columnCount || 0, 8);
        const rows = [];
        worksheet.eachRow({ includeEmpty: false }, (row) => {
            const cells = [];
            for (let col = 1; col <= maxColumn; col += 1) {
                cells.push(this.normalizeExcelCellValue(row.getCell(col).value));
            }
            if (cells.some((value) => String(value || '').trim() !== '')) {
                rows.push({ rowNumber: row.number, cells });
            }
        });
        return rows;
    }

    formatLocalDateTimeForSheet(date = new Date()) {
        const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
        const offset = source.getTimezoneOffset() * 60000;
        return new Date(source.getTime() - offset).toISOString().slice(0, 16);
    }

    formatGeneratedDateLabel(value) {
        if (!value) return 'Pending';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    createBatchExamId() {
        return `EX${Date.now().toString(36).toUpperCase().slice(-6)}`;
    }

    createSequentialSheetId(index) {
        return String(index + 1).padStart(3, '0');
    }

    assignGeneratedRosterFields(students) {
        const batchExamId = this.createBatchExamId();
        const batchDateTime = this.formatLocalDateTimeForSheet();
        return [...students]
            .sort((a, b) => {
                const nameCompare = String(a.studentName || '').localeCompare(String(b.studentName || ''), undefined, { sensitivity: 'base' });
                if (nameCompare !== 0) return nameCompare;
                return Number(a.sourceRow || 0) - Number(b.sourceRow || 0);
            })
            .map((student, index) => {
                const sheetId = this.createSequentialSheetId(index);
                return {
                    ...student,
                    sheetId,
                    examId: batchExamId,
                    roomNo: student.roomNo || String(Math.floor(index / 20) + 1),
                    seatNo: student.seatNo || String((index % 20) + 1),
                    dateTime: student.dateTime || batchDateTime
                };
            });
    }

    ensureGeneratedQrMetadata() {
        const setIfBlank = (id, value) => {
            const el = document.getElementById(id);
            if (el && !String(el.value || '').trim()) el.value = value;
        };
        setIfBlank('qrExamId', this.createBatchExamId());
        setIfBlank('qrRoomNo', '1');
        setIfBlank('qrSeatNo', '1');
        setIfBlank('qrDateTime', this.formatLocalDateTimeForSheet());
    }

    hashString(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    createManualSheetId(examId) {
        const storageKey = 'scancheck_manual_sheet_counter';
        const current = Number.parseInt(localStorage.getItem(storageKey) || '0', 10);
        const next = Number.isFinite(current) ? current + 1 : 1;
        localStorage.setItem(storageKey, String(next));
        return this.createSequentialSheetId(next - 1);
    }

    getCourseLogoForCourse(courseName) {
        const courseLogoMap = {
            'Bachelor of Science in Criminology': 'Bachelor of Science in Criminology.png',
            'Bachelor of Elementary Education': 'Bachelor of Elementary Education.png',
            'Bachelor of Secondary Education': 'pcc.png',
            'Bachelor of Science in Hospitality Management': 'Bachelor of Science in Hospitality Management.png',
            'Bachelor of Science in Business Administration': 'Bachelor of Science in Business Administration.png',
            'Bachelor of Science in Information Technology': 'Bachelor of Science in Information Technology.png'
        };
        return courseLogoMap[String(courseName || '').trim()] || 'pcc.png';
    }

    getSelectedExamForSheet() {
        const selectedQuizId = document.getElementById('examQuizSelect')?.value || '';
        return this.quizzes.find((quiz) => String(quiz.id) === String(selectedQuizId)) || null;
    }

    buildStudentAnswerSheetConfig(studentData, selectedQuiz = null) {
        const quiz = selectedQuiz || this.getSelectedExamForSheet();
        const course = studentData?.course || document.getElementById('qrCourse')?.value || '';
        return {
            id: quiz?.id || studentData?.examId || null,
            quizId: quiz?.id || null,
            title: 'ENTRANCE EXAMINATION',
            courseName: course || 'Answer Sheet',
            courseLogo: this.getCourseLogoForCourse(course),
            deptColor: '#004a99',
            studentData,
            questionCount: quiz?.questionCount || 100,
            options: quiz?.options || 4,
            format: quiz?.format || 'multi-subject',
            correctAnswers: Array.isArray(quiz?.correctAnswers) ? quiz.correctAnswers : [],
            subjectConfig: quiz?.subjectConfig || this.getSavedMultiSubjects(),
            subjects: this.getSubjectConfigForQuiz(quiz || {})
        };
    }

    renderStudentAnswerSheetMarkup(studentData, selectedQuiz = null) {
        const config = this.buildStudentAnswerSheetConfig(studentData, selectedQuiz);
        const generator = (config.format === 'normal' && window.normalAnswerSheetGenerator) 
            ? window.normalAnswerSheetGenerator 
            : window.answerSheetGenerator;
        
        if (!generator) return '';
        
        const stage = document.createElement('div');
        stage.style.position = 'fixed';
        stage.style.left = '-10000px';
        stage.style.top = '0';
        stage.style.width = '8.5in';
        stage.style.background = '#fff';
        stage.style.pointerEvents = 'none';
        stage.style.visibility = 'hidden';
        const mount = document.createElement('div');
        stage.appendChild(mount);
        document.body.appendChild(stage);
        try {
            generator.generate(config, mount);
            return mount.innerHTML;
        } finally {
            stage.remove();
        }
    }

    getStudentImportValue(cells, headerMap, key, fallback = '') {
        const index = headerMap[key];
        if (index == null || index < 0) return fallback;
        const value = this.normalizeExcelCellValue(cells[index]);
        return value || fallback;
    }

    async handleStudentExcelImport(file) {
        if (!file) return;
        const fileName = String(file.name || '');
        if (/\.xls$/i.test(fileName) && !/\.xlsx$/i.test(fileName)) {
            this.showToast('Old .xls files are not supported. Save the file as .xlsx or CSV.', 'warning');
            return;
        }
        if (!/\.(xlsx|csv)$/i.test(fileName)) {
            this.showToast('Import an .xlsx or CSV file.', 'warning');
            return;
        }

        this.setStudentImportStatus('Reading student list...', 'primary');
        try {
            const rows = await this.readStudentImportRows(file);
            if (!rows.length) throw new Error('The imported file has no rows.');

            const headerRow = rows[0];
            const headerMap = this.mapStudentImportHeaders(headerRow.cells);
            if (headerMap.studentName < 0) {
                throw new Error('Missing student name column. Use Full Name, Name, or Student Name.');
            }

            this.studentImportBatchToken = Date.now().toString(36).toUpperCase();
            let skipped = 0;
            const importedRows = rows.slice(1).map((row, index) => {
                const cells = row.cells;
                const studentName = this.getStudentImportValue(cells, headerMap, 'studentName');
                if (!studentName) {
                    skipped += 1;
                    return null;
                }
                const student = {
                    _batchKey: `${row.rowNumber}-${index}-${this.hashString(studentName)}`,
                    sourceRow: row.rowNumber,
                    studentName,
                    age: this.getStudentImportValue(cells, headerMap, 'age'),
                    course: this.getStudentImportValue(cells, headerMap, 'course'),
                    roomNo: this.getStudentImportValue(cells, headerMap, 'roomNo'),
                    seatNo: this.getStudentImportValue(cells, headerMap, 'seatNo'),
                    dateTime: this.getStudentImportValue(cells, headerMap, 'dateTime')
                };
                return student;
            }).filter(Boolean);

            if (!importedRows.length) throw new Error('No valid student rows found.');

            const students = this.assignGeneratedRosterFields(importedRows);
            this.importedStudents = students;
            this.filteredImportedStudents = [...students];
            this.activeImportedStudentIndex = -1;
            document.getElementById('qrExcelStudentSearch')?.removeAttribute('disabled');
            const skippedText = skipped ? ` ${skipped} blank row${skipped === 1 ? '' : 's'} skipped.` : '';
            this.setStudentImportStatus(`${students.length} student${students.length === 1 ? '' : 's'} imported from ${fileName}. IDs assigned alphabetically, 20 seats per room.${skippedText}`, 'success');
            this.renderImportedStudentList();
            this.applyImportedStudentAt(0, { renderSheet: true, warnMissingExam: true });
            this.showToast(`Imported ${students.length} student${students.length === 1 ? '' : 's'}.`, 'success');
        } catch (error) {
            console.error('Student import failed:', error);
            this.clearImportedStudentBatch(false);
            this.setStudentImportStatus(error.message || 'Student import failed.', 'danger');
            this.showToast(error.message || 'Student import failed.', 'danger');
        }
    }

    setSelectValueWithFallback(selectId, value) {
        const select = document.getElementById(selectId);
        if (!select) return;
        const text = String(value || '').trim();
        if (!text) {
            select.value = '';
            return;
        }
        const exists = Array.from(select.options).some((option) => option.value === text);
        if (!exists) {
            const option = document.createElement('option');
            option.value = text;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = text;
    }

    updateGeneratedSheetMeta(student = null) {
        const active = student || this.getActiveImportedStudent();
        const sheetId = active?.sheetId || active?.studentId || document.getElementById('qrStudentId')?.value || '';
        const examId = active?.examId || document.getElementById('qrExamId')?.value || '';
        const roomNo = active?.roomNo || document.getElementById('qrRoomNo')?.value || '';
        const seatNo = active?.seatNo || document.getElementById('qrSeatNo')?.value || '';
        const dateTime = active?.dateTime || document.getElementById('qrDateTime')?.value || '';
        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value || 'Pending';
        };
        setText('qrGeneratedSheetIdDisplay', sheetId || 'Pending');
        setText('qrGeneratedExamIdDisplay', examId || 'Pending');
        setText('qrGeneratedRoomSeatDisplay', roomNo && seatNo ? `${roomNo} / ${seatNo}` : 'Pending');
        setText('qrGeneratedDateTimeDisplay', this.formatGeneratedDateLabel(dateTime));
    }

    fillStudentQrForm(student) {
        if (!student) return;
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
        };
        setValue('qrStudentName', student.studentName);
        setValue('qrStudentId', student.sheetId);
        setValue('qrStudentAge', student.age);
        this.setSelectValueWithFallback('qrCourse', student.course);
        setValue('qrExamId', student.examId);
        setValue('qrRoomNo', student.roomNo);
        setValue('qrSeatNo', student.seatNo);
        if (student.dateTime) setValue('qrDateTime', student.dateTime);
        this.updateGeneratedSheetMeta(student);
    }

    getActiveImportedStudent() {
        if (this.activeImportedStudentIndex < 0) return null;
        return this.importedStudents[this.activeImportedStudentIndex] || null;
    }

    applyImportedStudentAt(index, options = {}) {
        const student = this.importedStudents[index];
        if (!student) return;
        this.activeImportedStudentIndex = index;
        this.fillStudentQrForm(student);
        this.renderImportedStudentList();
        this.renderBatchPreviewNav();

        if (!options.renderSheet) return;
        const selectedQuizId = document.getElementById('examQuizSelect')?.value || '';
        if (!selectedQuizId && options.warnMissingExam) {
            this.showToast('Student loaded. Select an exam before generating the answer sheet.', 'warning');
            return;
        }
        this.generateStudentBarcodeSheet({ preserveSheetId: true, silent: true });
    }

    selectImportedStudentByKey(batchKey) {
        const index = this.importedStudents.findIndex((student) => student._batchKey === batchKey);
        if (index >= 0) this.applyImportedStudentAt(index, { renderSheet: true });
    }

    filterImportedStudents(query = '') {
        const term = String(query || '').trim().toLowerCase();
        this.filteredImportedStudents = term
            ? this.importedStudents.filter((student) => {
                return [
                    student.studentName,
                    student.sheetId,
                    student.course,
                    student.roomNo,
                    student.seatNo
                ].some((value) => String(value || '').toLowerCase().includes(term));
            })
            : [...this.importedStudents];
        this.renderImportedStudentList();
        this.renderBatchPreviewNav();
    }

    renderImportedStudentList() {
        const container = document.getElementById('qrExcelStudentList');
        if (!container) return;
        container.innerHTML = '';
        if (!this.importedStudents.length) {
            container.innerHTML = '<div class="text-muted small">Import a roster to generate sheets in batch.</div>';
            return;
        }
        if (!this.filteredImportedStudents.length) {
            container.innerHTML = '<div class="text-muted small">No matching students.</div>';
            return;
        }
        const visible = this.filteredImportedStudents.slice(0, 30);
        visible.forEach((student) => {
            const index = this.importedStudents.findIndex((item) => item._batchKey === student._batchKey);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `list-group-item list-group-item-action d-flex justify-content-between align-items-start ${index === this.activeImportedStudentIndex ? 'active' : ''}`;
            button.addEventListener('click', () => this.selectImportedStudentByKey(student._batchKey));
            const info = document.createElement('span');
            info.className = 'text-start';
            const name = document.createElement('span');
            name.className = 'fw-semibold d-block';
            name.textContent = student.studentName;
            const meta = document.createElement('span');
            meta.className = index === this.activeImportedStudentIndex ? 'small text-white-50' : 'small text-muted';
            const roomSeat = student.roomNo && student.seatNo ? `Room ${student.roomNo}, Seat ${student.seatNo}` : 'Room pending';
            meta.textContent = `Sheet ${student.sheetId} • ${roomSeat}${student.course ? ` • ${student.course}` : ''}`;
            info.appendChild(name);
            info.appendChild(meta);
            const row = document.createElement('span');
            row.className = 'badge rounded-pill bg-light text-primary';
            row.textContent = `Row ${student.sourceRow}`;
            button.appendChild(info);
            button.appendChild(row);
            container.appendChild(button);
        });
        if (this.filteredImportedStudents.length > visible.length) {
            const more = document.createElement('div');
            more.className = 'text-muted small px-2 py-1';
            more.textContent = `Showing 30 of ${this.filteredImportedStudents.length}. Use search to narrow the list.`;
            container.appendChild(more);
        }
    }

    getImportedNavigationPool() {
        return this.filteredImportedStudents.length ? this.filteredImportedStudents : this.importedStudents;
    }

    navigateImportedStudent(delta) {
        const pool = this.getImportedNavigationPool();
        if (!pool.length) return;
        const activeKey = this.getActiveImportedStudent()?._batchKey;
        let poolIndex = pool.findIndex((student) => student._batchKey === activeKey);
        if (poolIndex < 0) poolIndex = delta > 0 ? -1 : 0;
        const nextPoolIndex = (poolIndex + delta + pool.length) % pool.length;
        const nextKey = pool[nextPoolIndex]._batchKey;
        const nextIndex = this.importedStudents.findIndex((student) => student._batchKey === nextKey);
        this.applyImportedStudentAt(nextIndex, { renderSheet: true });
    }

    renderBatchPreviewNav() {
        const nav = document.getElementById('qrPreviewBatchNav');
        const counter = document.getElementById('qrPreviewStudentCounter');
        const prev = document.getElementById('qrPreviewPrevStudent');
        const next = document.getElementById('qrPreviewNextStudent');
        if (!nav || !counter) return;
        const pool = this.getImportedNavigationPool();
        const active = this.getActiveImportedStudent();
        if (!this.importedStudents.length || !active) {
            nav.classList.add('d-none');
            return;
        }
        const poolIndex = Math.max(0, pool.findIndex((student) => student._batchKey === active._batchKey));
        nav.classList.remove('d-none');
        counter.textContent = `${poolIndex + 1} / ${pool.length} - ${active.studentName}`;
        if (prev) prev.disabled = pool.length <= 1;
        if (next) next.disabled = pool.length <= 1;
    }

    clearImportedStudentBatch(updateStatus = true) {
        this.importedStudents = [];
        this.filteredImportedStudents = [];
        this.activeImportedStudentIndex = -1;
        this.studentImportBatchToken = '';
        const search = document.getElementById('qrExcelStudentSearch');
        if (search) {
            search.value = '';
            search.setAttribute('disabled', 'disabled');
        }
        const list = document.getElementById('qrExcelStudentList');
        if (list) list.innerHTML = '<div class="text-muted small">Import a roster to generate sheets in batch.</div>';
        document.getElementById('qrPreviewBatchNav')?.classList.add('d-none');
        if (updateStatus) this.setStudentImportStatus('No imported student list.');
    }

    generateStudentBarcodeSheet(options = {}) {
        const studentName = document.getElementById('qrStudentName').value.trim();
        if (!studentName) {
            this.showToast('Please enter student name', 'warning');
            return false;
        }
        const activeImportedStudent = this.getActiveImportedStudent();
        const idInput = document.getElementById('qrStudentId');
        this.ensureGeneratedQrMetadata();
        const examIdEl = document.getElementById('qrExamId');
        const roomEl = document.getElementById('qrRoomNo');
        const seatEl = document.getElementById('qrSeatNo');
        const dateEl = document.getElementById('qrDateTime');
        const examIdInput = (examIdEl?.value || activeImportedStudent?.examId || '').trim();
        const examId = examIdInput || this.createBatchExamId();
        if (examIdEl) examIdEl.value = examId;
        const existingSheetId = String(idInput?.value || activeImportedStudent?.sheetId || '').trim();
        const sheetId = (options.preserveSheetId || activeImportedStudent) && existingSheetId
            ? existingSheetId
            : this.createManualSheetId(examId);
        if (idInput) idInput.value = sheetId;
        if (activeImportedStudent && activeImportedStudent.sheetId !== sheetId) {
            activeImportedStudent.sheetId = sheetId;
        }

        const studentData = {
            studentName: studentName,
            examId: examId,
            sheetId: sheetId,
            age: document.getElementById('qrStudentAge').value,
            course: document.getElementById('qrCourse').value,
            roomNo: roomEl?.value || '1',
            seatNo: seatEl?.value || '1',
            dateTime: dateEl?.value || this.formatLocalDateTimeForSheet()
        };
        if (activeImportedStudent) {
            Object.assign(activeImportedStudent, studentData);
        }
        this.updateGeneratedSheetMeta(studentData);

        const selectedQuiz = this.getSelectedExamForSheet();
        const config = this.buildStudentAnswerSheetConfig(studentData, selectedQuiz);
        const previewContainer = document.getElementById('omr-sheet');
        if (previewContainer) {
            previewContainer.innerHTML = '';
            if (selectedQuiz?.format === 'normal' && window.normalAnswerSheetGenerator) {
                window.normalAnswerSheetGenerator.generate(config, previewContainer);
            } else if (window.answerSheetGenerator) {
                window.answerSheetGenerator.generate(config, previewContainer);
            }

            scanCheckConfig.currentQuiz = {
                ...(selectedQuiz || {}),
                id: selectedQuiz?.id || examId,
                title: selectedQuiz?.title || `${examId} - ${studentName}`,
                questionCount: config.questionCount,
                options: config.options,
                format: selectedQuiz?.format || config.format,
                subjectConfig: config.subjectConfig,
                studentData
            };
            localStorage.setItem('scancheck_current_quiz', JSON.stringify(scanCheckConfig.currentQuiz));
            this.renderBatchPreviewNav();
            this.applyAnswerSheetPreviewZoom();
            if (!options.silent) this.showToast('Student QR applied to answer sheet preview.', 'success');
            return true;
        } else {
            this.showToast('Preview container or generator not found', 'danger');
            return false;
        }
    }

    clearBarcodePreview() {
        this.clearImportedStudentBatch();
        const idInput = document.getElementById('qrStudentId');
        if (idInput) idInput.value = '';
        ['qrExamId', 'qrRoomNo', 'qrSeatNo', 'qrDateTime'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        this.updateGeneratedSheetMeta();
        setTimeout(() => this.syncExamSelectionToPreview(true), 0);
    }

    generateGenericSheet() {
        const select = document.getElementById('examQuizSelect');
        const qId = select.value;
        const q = this.quizzes.find(x => String(x.id) === String(qId));
        
        if (!q) {
            this.showToast('Please select an exam first', 'warning');
            return;
        }

        const config = {
            ...q,
            courseName: 'Answer Sheet',
            courseLogo: 'pcc.png'
        };
        
        const previewContainer = document.getElementById('omr-sheet');
        if (previewContainer) {
            previewContainer.innerHTML = '';
            if (q.format === 'normal' && window.normalAnswerSheetGenerator) {
                window.normalAnswerSheetGenerator.generate(config, previewContainer);
            } else if (window.answerSheetGenerator) {
                window.answerSheetGenerator.generate(config, previewContainer);
            }
        }

        scanCheckConfig.currentQuiz = {
            ...q,
            id: q.id,
            title: q.title,
            questionCount: config.questionCount,
            options: config.options,
            format: config.format,
            subjectConfig: config.subjectConfig
        };
        localStorage.setItem('scancheck_current_quiz', JSON.stringify(scanCheckConfig.currentQuiz));
        this.applyAnswerSheetPreviewZoom();
        this.showToast(`Generated ${q.format === 'normal' ? 'Normal' : 'Multi-Subject'} answer sheet`, 'success');
        
        document.getElementById('answerSheetPreview').scrollIntoView({ behavior: 'smooth' });
    }

    syncExamSelectionToPreview(force = false) {
        const select = document.getElementById('examQuizSelect');
        if (!select) return false;
        const quizId = select.value;
        const quiz = this.quizzes.find(x => String(x.id) === String(quizId));
        
        if (!quiz && !force) return false;

        // Update edit subjects button visibility
        this.toggleSubjectsButton(quiz?.format);

        const config = quiz ? {
            ...quiz,
            courseName: 'Answer Sheet',
            courseLogo: 'pcc.png'
        } : {
            questions: 100,
            options: 4,
            format: 'multi-subject'
        };

        const previewContainer = document.getElementById('omr-sheet');
        if (previewContainer) {
            previewContainer.innerHTML = '';
            if (quiz?.format === 'normal' && window.normalAnswerSheetGenerator) {
                window.normalAnswerSheetGenerator.generate(config, previewContainer);
            } else if (window.answerSheetGenerator) {
                window.answerSheetGenerator.generate(config, previewContainer);
            }
        }

        if (quiz) {
            scanCheckConfig.currentQuiz = {
                ...quiz,
                id: quiz.id,
                title: quiz.title,
                questionCount: config.questionCount,
                options: config.options,
                format: config.format,
                subjectConfig: config.subjectConfig
            };
            localStorage.setItem('scancheck_current_quiz', JSON.stringify(scanCheckConfig.currentQuiz));
        }

        return true;
    }

}

// Global functions
function updateServerUrl() {
    const url = document.getElementById('serverUrl').value;

    scanCheckConfig.updateServerUrl(url).then(result => {
        window.app.showToast(result.message, result.success ? 'success' : 'danger');
        window.app.checkServerConnection();
    });
}

function generateAnswerSheet() {
    const select = document.getElementById('examQuizSelect');
    const quizId = select ? select.value : null;
    
    if (!quizId) {
        if (window.app) window.app.showToast('Select an exam first', 'warning');
        return;
    }

    if (window.app && window.app.syncExamSelectionToPreview(true)) {
        const preview = document.getElementById('answerSheetPreview');
        if (preview) {
            preview.classList.remove('flash-outline');
            void preview.offsetWidth;
            preview.classList.add('flash-outline');
        }
    }
}

async function downloadAnswerSheetImage() {
    let sheet = document.querySelector('#omr-sheet .answer-sheet');
    if (!sheet && window.app) {
        window.app.syncExamSelectionToPreview(true);
        sheet = document.querySelector('#omr-sheet .answer-sheet');
    }
    if (!sheet) {
        if (window.app) window.app.showToast('Generate an answer sheet first.', 'warning');
        return;
    }

    const copyImagesAsDataUrls = async (clone) => {
        const originalImages = Array.from(sheet.querySelectorAll('img'));
        const clonedImages = Array.from(clone.querySelectorAll('img'));

        await Promise.all(originalImages.map(async (img, index) => {
            const clonedImg = clonedImages[index];
            if (!clonedImg || !img.src) return;
            try {
                const response = await fetch(img.src);
                const blob = await response.blob();
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
                clonedImg.setAttribute('src', dataUrl);
            } catch (error) {
                // keep original src when fetch fails
            }
        }));
    };

    const ensureHtml2Canvas = async () => {
        if (window.html2canvas) return window.html2canvas;
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/vendor/html2canvas/html2canvas.min.js';
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load html2canvas'));
            document.head.appendChild(script);
        });
        return window.html2canvas;
    };

    try {
        const quiz = scanCheckConfig.currentQuiz || JSON.parse(localStorage.getItem('scancheck_current_quiz') || 'null');
        const studentData = quiz?.studentData || {};
        const baseName = [studentData.studentName, studentData.sheetId || studentData.studentId]
            .filter(Boolean)
            .join('-') || quiz?.title || 'answer-sheet';
        const safeName = String(baseName)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'answer-sheet';

        // Primary export path: html2canvas (more reliable than SVG foreignObject on many browsers).
        try {
            const clone = sheet.cloneNode(true);
            await copyImagesAsDataUrls(clone);

            const stage = document.createElement('div');
            stage.style.position = 'fixed';
            stage.style.left = '-99999px';
            stage.style.top = '0';
            stage.style.background = '#fff';
            stage.style.zIndex = '-1';
            stage.appendChild(clone);
            document.body.appendChild(stage);
            try {
                const html2canvas = await ensureHtml2Canvas();
                const canvas = await html2canvas(clone, {
                    backgroundColor: '#ffffff',
                    scale: 2,
                    useCORS: true,
                    logging: false,
                    onclone: (clonedDoc) => {
                        const warningNodes = clonedDoc.querySelectorAll('[data-export-warning="1"]');
                        warningNodes.forEach((el) => {
                            el.style.display = 'block';
                            el.style.color = '#d32f2f';
                            el.style.fontFamily = 'Arial, sans-serif';
                            el.style.fontWeight = '900';
                            el.style.fontSize = '12px';
                            el.style.lineHeight = '1.25';
                        });
                    }
                });

                const link = document.createElement('a');
                link.href = canvas.toDataURL('image/png');
                link.download = `${safeName}.png`;
                document.body.appendChild(link);
                link.click();
                link.remove();
            } finally {
                stage.remove();
            }

            if (window.app) window.app.showToast('Answer sheet downloaded as PNG.', 'success');
            return;
        } catch (primaryErr) {
            console.warn('Primary PNG export path failed, trying SVG fallback:', primaryErr);
        }

        // Secondary export path: SVG foreignObject rasterization.
        const clone = sheet.cloneNode(true);
        await copyImagesAsDataUrls(clone);

        const wrapper = document.createElement('div');
        wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        wrapper.style.background = '#ffffff';
        wrapper.style.width = '8.5in';
        wrapper.style.minHeight = '13in';
        wrapper.appendChild(clone);

        const serializer = new XMLSerializer();
        const svgMarkup = `
            <svg xmlns="http://www.w3.org/2000/svg" width="816" height="1248" viewBox="0 0 816 1248">
                <foreignObject width="100%" height="100%">${serializer.serializeToString(wrapper)}</foreignObject>
            </svg>
        `;

        const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        try {
            const scale = 2;
            const canvas = document.createElement('canvas');
            canvas.width = 816 * scale;
            canvas.height = 1248 * scale;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error('Canvas context unavailable');
            }
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            let rendered = false;
            if (typeof createImageBitmap === 'function') {
                try {
                    const bitmap = await createImageBitmap(svgBlob);
                    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                    if (typeof bitmap.close === 'function') bitmap.close();
                    rendered = true;
                } catch (_) {
                    rendered = false;
                }
            }
            if (!rendered) {
                const image = new Image();
                await new Promise((resolve, reject) => {
                    image.onload = resolve;
                    image.onerror = reject;
                    image.src = url;
                });
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            }

            const link = document.createElement('a');
            link.href = canvas.toDataURL('image/png');
            link.download = `${safeName}.png`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            if (window.app) window.app.showToast('Answer sheet downloaded as PNG.', 'success');
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (error) {
        console.error('Failed to export answer sheet image:', error);
        if (window.app) window.app.showToast('Failed to download answer sheet.', 'danger');
    }
}

function openAnswerSheetPdf() {
    printAnswerSheet();
}

function printAnswerSheet() {
    const app = window.app;
    const importedStudents = Array.isArray(app?.importedStudents) ? app.importedStudents : [];
    let pageMarkup = [];
    let title = 'Answer Sheet';
    let paperWidth = '8.5in';
    let paperHeight = '13in';
    let paperLabel = 'long bond paper (8.5in x 13in)';
    let printGeometryConfig = null;

    if (importedStudents.length > 0) {
        const selectedQuiz = app.getSelectedExamForSheet();
        if (!selectedQuiz) {
            app.showToast('Select an exam before printing imported sheets.', 'warning');
            return;
        }
        printGeometryConfig = selectedQuiz;
        pageMarkup = importedStudents
            .map((student) => app.renderStudentAnswerSheetMarkup(student, selectedQuiz))
            .filter(Boolean);
        title = `${selectedQuiz.title || 'Exam'} - ${importedStudents.length} Answer Sheets`;
    } else {
        let sheet = document.querySelector('#omr-sheet .answer-sheet');
        if (!sheet && app) {
            app.syncExamSelectionToPreview(true);
            sheet = document.querySelector('#omr-sheet .answer-sheet');
        }
        if (!sheet) {
            if (app) app.showToast('Select and generate an answer sheet first.', 'warning');
            return;
        }
        const quiz = scanCheckConfig.currentQuiz || JSON.parse(localStorage.getItem('scancheck_current_quiz') || 'null');
        if (!quiz) {
            if (app) app.showToast('Select and generate an answer sheet first.', 'warning');
            return;
        }

        // Detect paper size from sheet data attribute or config
        const paperSizeKey = sheet.getAttribute('data-paper-size') || quiz.paperSize || 'a4';
        const paperSizes = {
            'a4': { width: '210mm', height: '297mm', label: 'a4 paper (210mm x 297mm)' },
            'long-bond': { width: '8.5in', height: '13in', label: 'long bond paper (8.5in x 13in)' },
            '11x14-bond': { width: '11in', height: '14in', label: '11×14 bond paper (11in x 14in)' },
        };
        const ps = paperSizes[paperSizeKey] || paperSizes['a4'];
        paperWidth = ps.width;
        paperHeight = ps.height;
        paperLabel = ps.label;

        const studentData = quiz.studentData || {};
        title = [studentData.studentName, studentData.sheetId || studentData.studentId, 'Answer Sheet']
            .filter(Boolean)
            .join(' - ') || 'Answer Sheet';
        printGeometryConfig = quiz;
        pageMarkup = [sheet.outerHTML];
    }

    if (!pageMarkup.length) {
        if (app) app.showToast('No answer sheets are available to print.', 'warning');
        return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        if (app) app.showToast('Pop-up blocked. Please allow pop-ups to print.', 'danger');
        return;
    }
    const baseHref = `${window.location.origin}${window.location.pathname}`;
    printWindow.document.write(`
        <html>
            <head>
                <title>${escapeHtml(title || 'Answer Sheet')}</title>
                <base href="${escapeHtml(baseHref)}">
                <style>
                    @page { size: ${paperWidth} ${paperHeight}; margin: 0; }
                    * { box-sizing: border-box; }
                    html, body { margin: 0; padding: 0; background: #fff; }
                    .print-instructions {
                        width: ${paperWidth};
                        margin: 0 auto;
                        padding: 0.12in 0.18in;
                        font-family: Arial, sans-serif;
                        font-size: 12px;
                        line-height: 1.35;
                        color: #7a2400;
                        background: #fff3cd;
                        border: 1px solid #f0ad4e;
                    }
                    .print-container {
                        width: ${paperWidth};
                        min-width: ${paperWidth};
                        max-width: ${paperWidth};
                        height: ${paperHeight};
                        min-height: ${paperHeight};
                        max-height: ${paperHeight};
                        margin: 0 auto;
                        background: #fff;
                        overflow: hidden;
                    }
                    .sheet-page {
                        width: ${paperWidth};
                        min-width: ${paperWidth};
                        max-width: ${paperWidth};
                        height: ${paperHeight};
                        min-height: ${paperHeight};
                        max-height: ${paperHeight};
                        margin: 0 auto;
                        background: #fff;
                        page-break-after: always;
                        break-after: page;
                        overflow: hidden;
                    }
                    .sheet-page:last-child { page-break-after: auto; break-after: auto; }
                    .answer-sheet {
                        margin: 0 auto !important;
                        overflow: hidden !important;
                        transform: none !important;
                    }
                    @media print {
                        body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                        .no-print, .print-instructions { display: none !important; }
                        .sheet-page { page-break-after: always; break-after: page; width: ${paperWidth} !important; height: ${paperHeight} !important; }
                        .sheet-page:last-child { page-break-after: auto; break-after: auto; }
                    }
                </style>
            </head>
            <body>
                <div class="print-instructions">
                    <strong>Scanner-safe print settings:</strong>
                    Use ${paperLabel}, Pages per sheet: 1, Scale: 100%.
                    Do not fit, shrink, or print multiple answer sheets on one page.
                </div>
                ${pageMarkup.map((markup) => `<div class="sheet-page">${markup}</div>`).join('')}
                    <script>
                    const printGeometryConfig = ${JSON.stringify(printGeometryConfig || {}).replace(/</g, '\\u003c')};
                    const validatePrintGeometry = () => {
                        try {
                            const savedLayout = window.opener?.latestOmrGeneratedLayout || null;
                            const generator = savedLayout?.format === 'normal'
                                ? window.opener?.normalAnswerSheetGenerator
                                : window.opener?.answerSheetGenerator;
                            const firstSheet = document.querySelector('.answer-sheet');
                            if (generator?.validateLayoutAgainstDom && firstSheet && savedLayout) {
                                generator.validateLayoutAgainstDom(firstSheet, printGeometryConfig, savedLayout, 'print-window');
                            }
                        } catch (error) {
                            console.warn('Print geometry validation failed:', error);
                        }
                    };
                    const waitForImages = () => Promise.all(
                        Array.from(document.images).map((img) => {
                            if (img.complete) return Promise.resolve();
                            return new Promise((resolve) => {
                                img.onload = resolve;
                                img.onerror = resolve;
                            });
                        })
                    );
                    window.onload = async () => {
                        await waitForImages();
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                validatePrintGeometry();
                                window.print();
                            });
                        });
                    };
                </script>
            </body>
        </html>
    `);
    printWindow.document.close();
    if (app && importedStudents.length > 1) {
        app.showToast(`Prepared ${importedStudents.length} answer sheet pages for printing.`, 'success');
    }
}

function saveAnswerKey() {
    if (!window.app) return;
    window.app.handleAnswerKeySave();
}

function deleteAnswerKey() {
    if (!window.app) return;
    window.app.handleAnswerKeyDelete();
}

function shouldBlockMobileWebAccess() {
    const ua = navigator.userAgent || '';
    const isMobileUa = /(android|iphone|ipod|ipad|iemobile|opera mini|blackberry|webos)/i.test(ua);
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const isSmallViewport = window.matchMedia('(max-width: 1024px)').matches;
    return isMobileUa || (isTouch && isSmallViewport);
}

function enableMobileAccessBlockScreen() {
    document.body.classList.add('mobile-access-blocked');
    const block = document.getElementById('mobileAccessBlock');
    if (block) block.classList.remove('d-none');
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    if (shouldBlockMobileWebAccess()) {
        enableMobileAccessBlockScreen();
        return;
    }
    window.app = new ScanCheckApp();
});
