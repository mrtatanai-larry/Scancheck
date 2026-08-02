package com.scan.scancheckerapp.data.remote

data class ScanUploadRequest(
    val sheetId: String?,
    val studentId: String?,
    val examId: String?,
    val imageFileName: String,
    val studentName: String,
    val course: String,
    val age: Int?,
    val imageData: String,
    val deviceId: String?,
    val qrRawText: String?,
    val ocrRawText: String?,
    val capturedAt: Long
)
