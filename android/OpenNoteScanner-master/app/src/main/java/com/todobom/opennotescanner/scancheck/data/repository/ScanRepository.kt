package com.todobom.opennotescanner.scancheck.data.repository

import android.content.Context
import android.provider.Settings
import android.util.Base64
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.todobom.opennotescanner.scancheck.data.local.ScanRecord
import com.todobom.opennotescanner.scancheck.data.local.ScanRecordDao
import com.todobom.opennotescanner.scancheck.data.local.ScanStatus
import com.todobom.opennotescanner.scancheck.data.preferences.SettingsRepository
import com.todobom.opennotescanner.scancheck.data.remote.ScanUploadRequest
import com.todobom.opennotescanner.scancheck.data.remote.ScanUploadServiceFactory
import com.todobom.opennotescanner.scancheck.domain.ocr.OcrService
import com.todobom.opennotescanner.scancheck.domain.ocr.OcrTextParser
import com.todobom.opennotescanner.scancheck.domain.qr.QrCodeService
import com.todobom.opennotescanner.scancheck.domain.qr.QrIdentity
import com.todobom.opennotescanner.scancheck.sync.UploadScanWorker
import kotlinx.coroutines.flow.Flow
import java.io.File
import java.io.IOException

class ScanRepository(
    private val context: Context,
    private val dao: ScanRecordDao,
    private val settingsRepository: SettingsRepository,
    parser: OcrTextParser
) {
    private val ocrService = OcrService(context, parser)
    private val qrCodeService = QrCodeService(context)
    private val workManager = WorkManager.getInstance(context)

    fun observeRecords(): Flow<List<ScanRecord>> = dao.observeAll()

    fun observeApiBaseUrl() = settingsRepository.apiBaseUrl

    fun currentApiBaseUrl(): String = settingsRepository.currentApiBaseUrl()

    suspend fun updateApiBaseUrl(value: String) {
        settingsRepository.updateApiBaseUrl(value)
    }

    suspend fun isServerReachable(): Boolean {
        val baseUrl = currentApiBaseUrl()
        if (!settingsRepository.isValidBaseUrl(baseUrl)) return false
        return try {
            ScanUploadServiceFactory.create(baseUrl).healthCheck().isSuccessful
        } catch (_: Exception) {
            false
        }
    }

    suspend fun recordOpenNoteScan(savedFile: File): CaptureOutcome {
        return try {
            if (!savedFile.exists()) {
                return CaptureOutcome.Failure("The saved scan image does not exist.")
            }
            val capturedAt = System.currentTimeMillis()
            val qrIdentity = try {
                qrCodeService.readIdentity(savedFile)
            } catch (_: Exception) {
                QrIdentity(null, null, null, null)
            }
            val parsed = try {
                ocrService.recognize(savedFile)
            } catch (_: Exception) {
                com.todobom.opennotescanner.scancheck.domain.ocr.ParsedScanText(null, null, "")
            }

            if (dao.countByImageFileName(savedFile.name, null) > 0) {
                return CaptureOutcome.DuplicateBlocked(savedFile.name)
            }

            val record = persistRecord(
                savedFile = savedFile,
                capturedAt = capturedAt,
                qrIdentity = qrIdentity,
                studentName = qrIdentity.studentName?.trim()?.takeIf { it.isNotBlank() }
                    ?: parsed.studentName.orEmpty(),
                course = qrIdentity.course?.trim()?.takeIf { it.isNotBlank() }
                    ?: parsed.course.orEmpty(),
                rawText = parsed.rawText,
                status = ScanStatus.PENDING_UPLOAD
            )
            if (settingsRepository.isValidBaseUrl()) {
                enqueueRecordUpload(record.id)
            }
            CaptureOutcome.Saved(record, isDraft = !qrIdentity.hasSheetId, qrFound = qrIdentity.hasSheetId)
        } catch (exception: Exception) {
            CaptureOutcome.Failure(exception.message ?: "Unable to save the captured paper.")
        }
    }

    suspend fun updateRecordFields(recordId: Long, studentName: String, course: String): UpdateRecordResult {
        val currentRecord = dao.getById(recordId)
            ?: return UpdateRecordResult.Failure("The selected record no longer exists.")

        val trimmedName = studentName.trim()
        val trimmedCourse = course.trim()
        val updatedRecord = currentRecord.copy(
            studentName = trimmedName,
            course = trimmedCourse,
            normalizedStudentName = ScanFileManager.normalizeForDuplicateKey(trimmedName),
            normalizedCourse = ScanFileManager.normalizeForDuplicateKey(trimmedCourse),
            status = if (currentRecord.status == ScanStatus.DUPLICATE_REJECTED) {
                ScanStatus.DUPLICATE_REJECTED
            } else {
                ScanStatus.PENDING_UPLOAD
            },
            errorMessage = null
        )
        dao.update(updatedRecord)
        return UpdateRecordResult.Success(updatedRecord)
    }

    suspend fun deleteRecord(record: ScanRecord) {
        ScanFileManager.deleteStoredFile(record.imagePath)
        dao.deleteById(record.id)
    }

    suspend fun enqueuePendingUploads(): UploadRequestResult {
        val baseUrl = currentApiBaseUrl()
        if (!settingsRepository.isValidBaseUrl(baseUrl)) {
            return UploadRequestResult.InvalidBaseUrl(baseUrl)
        }

        val eligibleRecords = dao.getByStatuses(
            listOf(ScanStatus.PENDING_UPLOAD.name, ScanStatus.UPLOAD_FAILED.name)
        )

        if (eligibleRecords.isEmpty()) return UploadRequestResult.NothingToUpload

        eligibleRecords.forEach { record ->
            enqueueRecordUpload(record.id)
        }

        return UploadRequestResult.Scheduled(eligibleRecords.size)
    }

    suspend fun uploadRecord(recordId: Long): ListenableWorker.Result {
        val record = dao.getById(recordId) ?: return ListenableWorker.Result.success()
        val imageFile = File(record.imagePath)
        if (!imageFile.exists()) {
            dao.update(record.copy(status = ScanStatus.UPLOAD_FAILED, errorMessage = "The image file is missing from local storage."))
            return ListenableWorker.Result.failure()
        }

        val api = ScanUploadServiceFactory.create(currentApiBaseUrl())
        return try {
            val response = api.uploadScan(buildUploadRequest(record, imageFile))
            when {
                response.isSuccessful -> {
                    dao.update(
                        record.copy(
                            status = ScanStatus.UPLOADED,
                            remoteReceivedPaperId = response.body()?.id,
                            errorMessage = null
                        )
                    )
                    ListenableWorker.Result.success()
                }
                response.code() == 409 -> {
                    dao.update(
                        record.copy(
                            status = ScanStatus.DUPLICATE_REJECTED,
                            errorMessage = "Rejected by web app: duplicate filename ${record.imageFileName}."
                        )
                    )
                    ListenableWorker.Result.success()
                }
                response.code() >= 500 -> {
                    dao.update(record.copy(status = ScanStatus.UPLOAD_FAILED, errorMessage = "Upload failed with HTTP ${response.code()}."))
                    ListenableWorker.Result.retry()
                }
                else -> {
                    dao.update(record.copy(status = ScanStatus.UPLOAD_FAILED, errorMessage = "Upload failed with HTTP ${response.code()}."))
                    ListenableWorker.Result.failure()
                }
            }
        } catch (exception: IOException) {
            dao.update(record.copy(status = ScanStatus.UPLOAD_FAILED, errorMessage = exception.message ?: "Network error during upload."))
            ListenableWorker.Result.retry()
        } catch (exception: Exception) {
            dao.update(record.copy(status = ScanStatus.UPLOAD_FAILED, errorMessage = exception.message ?: "Unexpected upload error."))
            ListenableWorker.Result.failure()
        }
    }

    private fun buildUploadRequest(record: ScanRecord, imageFile: File): ScanUploadRequest {
        val photoBase64 = Base64.encodeToString(imageFile.readBytes(), Base64.NO_WRAP)
        val mimeType = when (imageFile.extension.lowercase()) {
            "png" -> "image/png"
            "gif" -> "image/gif"
            else -> "image/jpeg"
        }

        return ScanUploadRequest(
            sheetId = record.sheetId,
            studentId = record.studentId,
            examId = record.examId,
            imageFileName = record.imageFileName,
            studentName = record.studentName.ifBlank { "Unknown Student" },
            course = record.course.ifBlank { "Unassigned Course" },
            age = null,
            imageData = "data:$mimeType;base64,$photoBase64",
            deviceId = getDeviceId(),
            qrRawText = record.qrRawText,
            ocrRawText = record.ocrRawText,
            capturedAt = record.capturedAt
        )
    }

    private suspend fun persistRecord(
        savedFile: File,
        capturedAt: Long,
        qrIdentity: QrIdentity,
        studentName: String,
        course: String,
        rawText: String,
        status: ScanStatus
    ): ScanRecord {
        val normalizedName = ScanFileManager.normalizeForDuplicateKey(studentName)
        val normalizedCourse = ScanFileManager.normalizeForDuplicateKey(course)
        val record = ScanRecord(
            sheetId = qrIdentity.sheetId?.trim()?.takeIf { it.isNotBlank() },
            studentId = qrIdentity.studentId?.trim()?.takeIf { it.isNotBlank() },
            examId = qrIdentity.examId?.trim()?.takeIf { it.isNotBlank() },
            studentName = studentName.trim(),
            course = course.trim(),
            normalizedStudentName = normalizedName,
            normalizedCourse = normalizedCourse,
            imagePath = savedFile.absolutePath,
            imageFileName = savedFile.name,
            capturedAt = capturedAt,
            ocrRawText = rawText.trim(),
            qrRawText = qrIdentity.rawText,
            status = status,
            errorMessage = null
        )
        val insertedId = dao.insert(record)
        return record.copy(id = insertedId)
    }

    private suspend fun enqueueRecordUpload(recordId: Long) {
        val record = dao.getById(recordId) ?: return
        dao.update(record.copy(status = ScanStatus.UPLOADING, errorMessage = null))

        val workRequest = OneTimeWorkRequestBuilder<UploadScanWorker>()
            .setInputData(workDataOf(UploadScanWorker.KEY_SCAN_ID to recordId))
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()

        workManager.enqueueUniqueWork(
            "upload_scan_$recordId",
            ExistingWorkPolicy.REPLACE,
            workRequest
        )
    }

    private fun getDeviceId(): String {
        return Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
            ?: "android-device"
    }
}
