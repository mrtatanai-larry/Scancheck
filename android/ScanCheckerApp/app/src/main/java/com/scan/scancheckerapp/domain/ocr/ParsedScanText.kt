package com.scan.scancheckerapp.domain.ocr

data class ParsedScanText(
    val studentName: String?,
    val course: String?,
    val rawText: String
) {
    val hasCompleteFields: Boolean
        get() = !studentName.isNullOrBlank() && !course.isNullOrBlank()
}
