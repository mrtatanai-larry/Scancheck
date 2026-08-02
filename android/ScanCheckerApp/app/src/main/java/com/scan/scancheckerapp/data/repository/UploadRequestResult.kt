package com.scan.scancheckerapp.data.repository

sealed interface UploadRequestResult {
    data class Scheduled(val count: Int) : UploadRequestResult
    data class InvalidBaseUrl(val currentValue: String) : UploadRequestResult
    data object NothingToUpload : UploadRequestResult
}
