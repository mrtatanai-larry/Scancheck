package com.todobom.opennotescanner.scancheck.data.repository

import com.todobom.opennotescanner.scancheck.data.local.ScanRecord

sealed interface UpdateRecordResult {
    data class Success(val record: ScanRecord) : UpdateRecordResult
    data class Duplicate(val message: String) : UpdateRecordResult
    data class Failure(val message: String) : UpdateRecordResult
}
