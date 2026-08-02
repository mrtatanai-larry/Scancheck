package com.scan.scancheckerapp.data.repository

import com.scan.scancheckerapp.data.local.ScanRecord
import com.scan.scancheckerapp.domain.ocr.ParsedScanText

sealed interface CaptureOutcome {
    data class Saved(
        val record: ScanRecord,
        val isDraft: Boolean
    ) : CaptureOutcome

    data class RetakeNeeded(
        val nextAttemptCount: Int,
        val parsedScanText: ParsedScanText
    ) : CaptureOutcome

    data class DuplicateBlocked(
        val studentName: String,
        val course: String
    ) : CaptureOutcome

    data class Failure(
        val message: String
    ) : CaptureOutcome
}
