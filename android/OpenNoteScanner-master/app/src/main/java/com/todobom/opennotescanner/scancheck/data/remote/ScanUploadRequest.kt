package com.todobom.opennotescanner.scancheck.data.remote

import com.google.gson.annotations.SerializedName

data class ScanUploadRequest(
    @SerializedName("sheet_id") val sheetId: String?,
    @SerializedName("student_id") val studentId: String?,
    @SerializedName("exam_id") val examId: String?,
    @SerializedName("image_file_name") val imageFileName: String,
    @SerializedName("student_name") val studentName: String,
    val course: String,
    val age: Int? = null,
    @SerializedName("image_data") val imageData: String,
    @SerializedName("device_id") val deviceId: String,
    @SerializedName("qr_raw_text") val qrRawText: String?,
    @SerializedName("ocr_raw_text") val ocrRawText: String,
    @SerializedName("captured_at") val capturedAt: Long
)

data class ScanUploadResponse(
    val success: Boolean = false,
    val id: Long? = null,
    @SerializedName("image_file_name") val imageFileName: String? = null,
    @SerializedName("image_path") val imagePath: String? = null,
    val duplicate: Boolean = false,
    val error: String? = null
)
