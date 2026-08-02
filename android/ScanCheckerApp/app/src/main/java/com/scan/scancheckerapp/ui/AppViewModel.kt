package com.scan.scancheckerapp.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.scan.scancheckerapp.ScanCheckerApplication
import com.scan.scancheckerapp.data.local.ScanRecord
import com.scan.scancheckerapp.data.preferences.SettingsRepository
import com.scan.scancheckerapp.data.repository.CaptureOutcome
import com.scan.scancheckerapp.data.repository.ScanRepository
import com.scan.scancheckerapp.data.repository.UpdateRecordResult
import com.scan.scancheckerapp.data.repository.UploadRequestResult
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import java.io.File
import java.util.Locale

enum class ServerConnectionStatus {
    CHECKING,
    CONNECTED,
    DISCONNECTED
}

data class ScanAppUiState(
    val selectedScreen: AppScreen = AppScreen.SCAN,
    val records: List<ScanRecord> = emptyList(),
    val searchQuery: String = "",
    val selectedCourse: String? = null,
    val sortOrder: SortOrder = SortOrder.NAME_ASC,
    val showFilters: Boolean = false,
    val previewRecord: ScanRecord? = null,
    val editingRecord: ScanRecord? = null,
    val deleteCandidate: ScanRecord? = null,
    val apiBaseUrl: String = SettingsRepository.DEFAULT_API_BASE_URL,
    val availableCourses: List<String> = emptyList(),
    val retakeAttempts: Int = 0,
    val isProcessingCapture: Boolean = false,
    val pendingUploadCount: Int = 0,
    val serverConnectionStatus: ServerConnectionStatus = ServerConnectionStatus.CHECKING
)

private data class LocalUiState(
    val selectedScreen: AppScreen = AppScreen.SCAN,
    val searchQuery: String = "",
    val selectedCourse: String? = null,
    val sortOrder: SortOrder = SortOrder.NAME_ASC,
    val showFilters: Boolean = false,
    val previewRecordId: Long? = null,
    val editingRecordId: Long? = null,
    val deleteRecordId: Long? = null,
    val retakeAttempts: Int = 0,
    val isProcessingCapture: Boolean = false,
    val serverConnectionStatus: ServerConnectionStatus = ServerConnectionStatus.CHECKING
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val repository: ScanRepository = (application as ScanCheckerApplication).scanRepository
    private val localUiState = MutableStateFlow(LocalUiState())
    private val userMessages = MutableSharedFlow<String>()

    val messages = userMessages.asSharedFlow()

    init {
        viewModelScope.launch {
            repository.observeApiBaseUrl().collectLatest {
                refreshServerConnectionStatus()
            }
        }

        viewModelScope.launch {
            while (true) {
                delay(10_000)
                refreshServerConnectionStatus()
            }
        }
    }

    val uiState: StateFlow<ScanAppUiState> = combine(
        localUiState,
        repository.observeRecords(),
        repository.observeApiBaseUrl()
    ) { localState, records, apiBaseUrl ->
        val availableCourses = records
            .mapNotNull { it.course.takeIf(String::isNotBlank) }
            .distinct()
            .sorted()

        val filteredRecords = records
            .filter { record ->
                val searchQuery = localState.searchQuery.trim().lowercase(Locale.getDefault())
                val matchesSearch = searchQuery.isBlank() ||
                    record.studentName.lowercase(Locale.getDefault()).contains(searchQuery) ||
                    record.course.lowercase(Locale.getDefault()).contains(searchQuery) ||
                    record.examId.orEmpty().lowercase(Locale.getDefault()).contains(searchQuery) ||
                    record.sheetId.orEmpty().lowercase(Locale.getDefault()).contains(searchQuery)

                val matchesCourse = localState.selectedCourse.isNullOrBlank() ||
                    record.course.equals(localState.selectedCourse, ignoreCase = true)

                matchesSearch && matchesCourse
            }
            .sortedWith(
                compareBy<ScanRecord> { it.studentName.lowercase(Locale.getDefault()) }
                    .thenByDescending { it.capturedAt }
            )
            .let { sorted ->
                if (localState.sortOrder == SortOrder.NAME_DESC) sorted.reversed() else sorted
            }

        ScanAppUiState(
            selectedScreen = localState.selectedScreen,
            records = filteredRecords,
            searchQuery = localState.searchQuery,
            selectedCourse = localState.selectedCourse,
            sortOrder = localState.sortOrder,
            showFilters = localState.showFilters,
            previewRecord = records.firstOrNull { it.id == localState.previewRecordId },
            editingRecord = records.firstOrNull { it.id == localState.editingRecordId }
                ?: records.find { it.id == localState.editingRecordId },
            deleteCandidate = records.firstOrNull { it.id == localState.deleteRecordId }
                ?: records.find { it.id == localState.deleteRecordId },
            apiBaseUrl = apiBaseUrl,
            availableCourses = availableCourses,
            retakeAttempts = localState.retakeAttempts,
            isProcessingCapture = localState.isProcessingCapture,
            pendingUploadCount = records.count {
                it.status.name == "PENDING_UPLOAD" || it.status.name == "UPLOAD_FAILED"
            },
            serverConnectionStatus = localState.serverConnectionStatus
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = ScanAppUiState()
    )

    fun selectScreen(screen: AppScreen) {
        updateLocalState { copy(selectedScreen = screen) }
    }

    fun updateSearchQuery(query: String) {
        updateLocalState { copy(searchQuery = query) }
    }

    fun toggleFilters() {
        updateLocalState { copy(showFilters = !showFilters) }
    }

    fun selectCourseFilter(course: String?) {
        updateLocalState { copy(selectedCourse = course) }
    }

    fun selectSortOrder(sortOrder: SortOrder) {
        updateLocalState { copy(sortOrder = sortOrder) }
    }

    fun openPreview(record: ScanRecord) {
        updateLocalState { copy(previewRecordId = record.id) }
    }

    fun dismissPreview() {
        updateLocalState { copy(previewRecordId = null) }
    }

    fun openEditor(record: ScanRecord) {
        updateLocalState { copy(editingRecordId = record.id) }
    }

    fun dismissEditor() {
        updateLocalState { copy(editingRecordId = null) }
    }

    fun requestDelete(record: ScanRecord) {
        updateLocalState { copy(deleteRecordId = record.id) }
    }

    fun dismissDelete() {
        updateLocalState { copy(deleteRecordId = null) }
    }

    fun reportCameraError(message: String) {
        viewModelScope.launch {
            userMessages.emit(message)
        }
    }

    fun handleCapturedImage(tempFile: File) {
        viewModelScope.launch {
            updateLocalState { copy(isProcessingCapture = true) }
            when (val result = repository.processCapturedImage(tempFile, uiState.value.retakeAttempts)) {
                is CaptureOutcome.Saved -> {
                    updateLocalState {
                        copy(
                            isProcessingCapture = false,
                            retakeAttempts = 0,
                            selectedScreen = AppScreen.RESULTS
                        )
                    }
                    userMessages.emit(
                        if (result.isDraft) {
                            "Paper saved for web inbox upload. Review warning: ${result.record.needsReviewReason}"
                        } else {
                            "Paper saved with QR identity. Upload it from Scan Results."
                        }
                    )
                }
                is CaptureOutcome.RetakeNeeded -> {
                    updateLocalState {
                        copy(
                            isProcessingCapture = false,
                            retakeAttempts = result.nextAttemptCount
                        )
                    }
                    userMessages.emit(
                        "OCR could not find both Name and Course. Retake ${result.nextAttemptCount} of 2."
                    )
                }
                is CaptureOutcome.DuplicateBlocked -> {
                    updateLocalState {
                        copy(
                            isProcessingCapture = false,
                            retakeAttempts = 0
                        )
                    }
                    userMessages.emit(
                        "Duplicate blocked for ${result.studentName} (${result.course})."
                    )
                }
                is CaptureOutcome.Failure -> {
                    updateLocalState {
                        copy(
                            isProcessingCapture = false,
                            retakeAttempts = 0
                        )
                    }
                    userMessages.emit(result.message)
                }
            }
        }
    }

    fun saveEditedRecord(studentName: String, course: String) {
        val record = uiState.value.editingRecord ?: return
        viewModelScope.launch {
            when (val result = repository.updateRecordFields(record.id, studentName, course)) {
                is UpdateRecordResult.Success -> {
                    updateLocalState { copy(editingRecordId = null) }
                    userMessages.emit("Record updated.")
                }
                is UpdateRecordResult.Duplicate -> {
                    userMessages.emit(result.message)
                }
                is UpdateRecordResult.Failure -> {
                    userMessages.emit(result.message)
                }
            }
        }
    }

    fun confirmDelete() {
        val record = uiState.value.deleteCandidate ?: return
        viewModelScope.launch {
            repository.deleteRecord(record)
            updateLocalState { copy(deleteRecordId = null) }
            userMessages.emit("Record deleted.")
        }
    }

    fun uploadPendingRecords() {
        viewModelScope.launch {
            when (val result = repository.enqueuePendingUploads()) {
                is UploadRequestResult.Scheduled -> {
                    userMessages.emit("Queued ${result.count} record(s) for upload.")
                }
                is UploadRequestResult.InvalidBaseUrl -> {
                    userMessages.emit("Set a valid localhost URL in Settings before uploading.")
                    updateLocalState { copy(selectedScreen = AppScreen.SETTINGS) }
                }
                UploadRequestResult.NothingToUpload -> {
                    userMessages.emit("There are no pending records to upload.")
                }
            }
        }
    }

    fun saveApiBaseUrl(baseUrl: String) {
        viewModelScope.launch {
            repository.updateApiBaseUrl(baseUrl)
            refreshServerConnectionStatus()
            userMessages.emit("Localhost URL saved.")
        }
    }

    fun testServerConnection(baseUrl: String) {
        viewModelScope.launch {
            repository.updateApiBaseUrl(baseUrl)
            updateLocalState { copy(serverConnectionStatus = ServerConnectionStatus.CHECKING) }
            val isReachable = repository.isServerReachable()
            updateLocalState {
                copy(
                    serverConnectionStatus = if (isReachable) {
                        ServerConnectionStatus.CONNECTED
                    } else {
                        ServerConnectionStatus.DISCONNECTED
                    }
                )
            }
            userMessages.emit(
                if (isReachable) {
                    "Connection test passed."
                } else {
                    "Connection test failed. Check the URL and network."
                }
            )
        }
    }

    private suspend fun refreshServerConnectionStatus() {
        updateLocalState { copy(serverConnectionStatus = ServerConnectionStatus.CHECKING) }
        val isReachable = repository.isServerReachable()
        updateLocalState {
            copy(
                serverConnectionStatus = if (isReachable) {
                    ServerConnectionStatus.CONNECTED
                } else {
                    ServerConnectionStatus.DISCONNECTED
                }
            )
        }
    }

    private fun updateLocalState(transform: LocalUiState.() -> LocalUiState) {
        localUiState.value = localUiState.value.transform()
    }
}
