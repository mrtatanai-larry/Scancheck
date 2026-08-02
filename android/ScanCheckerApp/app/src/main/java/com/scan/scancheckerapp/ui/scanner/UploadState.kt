package com.scan.scancheckerapp.ui.scanner

sealed class UploadState {
    object Idle : UploadState()
    object ScanningQR : UploadState()
    data class ReadyToCapture(val examId: String, val qrData: String?) : UploadState()
    object Uploading : UploadState()
    object Success : UploadState()
    data class Error(val message: String) : UploadState()
}
