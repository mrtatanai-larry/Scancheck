package com.todobom.opennotescanner.scancheck.data.repository

import com.todobom.opennotescanner.scancheck.data.local.ScanRecord
import com.todobom.opennotescanner.scancheck.domain.ocr.ParsedScanText

sealed interface CaptureOutcome {
    data class Saved(
        val record: ScanRecord,
        val isDraft: Boolean,
        val qrFound: Boolean
    ) : CaptureOutcome

    data class RetakeNeeded(
        val nextAttemptCount: Int,
        val parsedScanText: ParsedScanText
    ) : CaptureOutcome

    data class DuplicateBlocked(
        val imageFileName: String
    ) : CaptureOutcome

    data class Failure(
        val message: String
    ) : CaptureOutcome
}
