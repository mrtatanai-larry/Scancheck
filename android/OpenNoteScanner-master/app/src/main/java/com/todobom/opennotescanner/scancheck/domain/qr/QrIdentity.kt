package com.todobom.opennotescanner.scancheck.domain.qr

data class QrIdentity(
    val sheetId: String?,
    val studentId: String?,
    val examId: String?,
    val rawText: String?,
    val studentName: String? = null,
    val course: String? = null,
    val age: String? = null,
    val roomNo: String? = null,
    val seatNo: String? = null,
    val entryType: String? = null,
    val equityGroup: String? = null
) {
    val hasSheetId: Boolean = !sheetId.isNullOrBlank()
}
