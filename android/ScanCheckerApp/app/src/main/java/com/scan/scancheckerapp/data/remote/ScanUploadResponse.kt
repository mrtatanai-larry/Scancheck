package com.scan.scancheckerapp.data.remote

data class ScanUploadResponse(
    val success: Boolean = false,
    val id: Long? = null,
    val sheet_id: String? = null,
    val student_id: String? = null,
    val exam_id: String? = null,
    val image_file_name: String? = null,
    val image_path: String? = null,
    val student_name: String? = null,
    val course: String? = null,
    val message: String? = null,
    val error: String? = null,
    val duplicate: Boolean? = null
)
