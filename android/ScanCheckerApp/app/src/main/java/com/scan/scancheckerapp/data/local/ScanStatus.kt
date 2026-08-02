package com.scan.scancheckerapp.data.local

enum class ScanStatus {
    DRAFT,
    PENDING_UPLOAD,
    UPLOADING,
    UPLOADED,
    UPLOAD_FAILED,
    DUPLICATE_REJECTED
}
