package com.todobom.opennotescanner.scancheck.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "scan_records",
    indices = [
        Index(
            value = ["imageFileName"],
            unique = true
        )
    ]
)
data class ScanRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sheetId: String? = null,
    val studentId: String? = null,
    val examId: String? = null,
    val studentName: String = "",
    val course: String = "",
    val normalizedStudentName: String? = null,
    val normalizedCourse: String? = null,
    val imagePath: String,
    val imageFileName: String,
    val capturedAt: Long,
    val ocrRawText: String,
    val qrRawText: String? = null,
    val remoteReceivedPaperId: Long? = null,
    val status: ScanStatus,
    val errorMessage: String? = null
)
