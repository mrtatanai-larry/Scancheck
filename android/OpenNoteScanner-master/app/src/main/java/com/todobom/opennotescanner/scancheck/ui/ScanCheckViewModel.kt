package com.todobom.opennotescanner.scancheck.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.todobom.opennotescanner.OpenNoteScannerApplication
import com.todobom.opennotescanner.scancheck.data.local.ScanRecord
import com.todobom.opennotescanner.scancheck.data.local.ScanStatus
import com.todobom.opennotescanner.scancheck.data.preferences.SettingsRepository
import com.todobom.opennotescanner.scancheck.data.repository.UploadRequestResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.Locale

enum class ServerConnectionStatus {
    CHECKING,
    CONNECTED,
    DISCONNECTED
}

data class ScanCheckUiState(
    val records: List<ScanRecord> = emptyList(),
    val searchQuery: String = "",
    val pendingUploadCount: Int = 0,
    val apiBaseUrl: String = SettingsRepository.DEFAULT_API_BASE_URL,
    val serverConnectionStatus: ServerConnectionStatus = ServerConnectionStatus.CHECKING,
    val message: String? = null
)

private data class LocalUiState(
    val searchQuery: String = "",
    val serverConnectionStatus: ServerConnectionStatus = ServerConnectionStatus.CHECKING,
    val message: String? = null
)

class ScanCheckViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as OpenNoteScannerApplication).scanRepository
    private val localUiState = MutableStateFlow(LocalUiState())

    val uiState: StateFlow<ScanCheckUiState> = combine(
        localUiState,
        repository.observeRecords(),
        repository.observeApiBaseUrl()
    ) { local, records, apiBaseUrl ->
        val query = local.searchQuery.trim().lowercase(Locale.getDefault())
        val filtered = records.filter { record ->
            query.isBlank() ||
                record.imageFileName.lowercase(Locale.getDefault()).contains(query) ||
                record.studentName.lowercase(Locale.getDefault()).contains(query) ||
                record.course.lowercase(Locale.getDefault()).contains(query)
        }

        ScanCheckUiState(
            records = filtered,
            searchQuery = local.searchQuery,
            pendingUploadCount = records.count {
                it.status == ScanStatus.PENDING_UPLOAD || it.status == ScanStatus.UPLOAD_FAILED
            },
            apiBaseUrl = apiBaseUrl,
            serverConnectionStatus = local.serverConnectionStatus,
            message = local.message
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = ScanCheckUiState()
    )

    init {
        checkServerConnection()
    }

    fun updateSearchQuery(query: String) {
        localUiState.value = localUiState.value.copy(searchQuery = query)
    }

    fun saveApiBaseUrl(value: String) {
        viewModelScope.launch {
            repository.updateApiBaseUrl(value)
            showMessage("Server URL saved.")
            checkServerConnection()
        }
    }

    fun checkServerConnection() {
        viewModelScope.launch {
            localUiState.value = localUiState.value.copy(serverConnectionStatus = ServerConnectionStatus.CHECKING)
            val connected = repository.isServerReachable()
            localUiState.value = localUiState.value.copy(
                serverConnectionStatus = if (connected) ServerConnectionStatus.CONNECTED else ServerConnectionStatus.DISCONNECTED
            )
        }
    }

    fun uploadPendingRecords() {
        viewModelScope.launch {
            when (val result = repository.enqueuePendingUploads()) {
                is UploadRequestResult.Scheduled -> showMessage("Queued ${result.count} record(s) for upload.")
                UploadRequestResult.NothingToUpload -> showMessage("No pending uploads.")
                is UploadRequestResult.InvalidBaseUrl -> showMessage("Invalid server URL: ${result.value}")
            }
        }
    }

    fun deleteRecord(record: ScanRecord) {
        viewModelScope.launch {
            repository.deleteRecord(record)
            showMessage("Record deleted.")
        }
    }

    fun consumeMessage() {
        localUiState.value = localUiState.value.copy(message = null)
    }

    private fun showMessage(message: String) {
        localUiState.value = localUiState.value.copy(message = message)
    }
}

class ScanCheckViewModelFactory(
    private val application: Application
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        return ScanCheckViewModel(application) as T
    }
}
