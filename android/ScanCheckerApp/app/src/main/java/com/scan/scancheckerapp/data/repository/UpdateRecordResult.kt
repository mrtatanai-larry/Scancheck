package com.scan.scancheckerapp.data.repository

import com.scan.scancheckerapp.data.local.ScanRecord

sealed interface UpdateRecordResult {
    data class Success(val record: ScanRecord) : UpdateRecordResult
    data class Duplicate(val message: String) : UpdateRecordResult
    data class Failure(val message: String) : UpdateRecordResult
}
