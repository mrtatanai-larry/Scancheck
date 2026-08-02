package com.todobom.opennotescanner.scancheck.data.local

enum class ScanStatus {
    DRAFT,
    PENDING_UPLOAD,
    UPLOADING,
    UPLOADED,
    DUPLICATE_REJECTED,
    UPLOAD_FAILED
}
