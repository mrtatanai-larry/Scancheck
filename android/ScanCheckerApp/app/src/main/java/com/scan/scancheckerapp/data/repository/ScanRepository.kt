package com.scan.scancheckerapp.data.repository

import android.content.Context
import android.util.Base64
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.scan.scancheckerapp.data.local.ScanRecord
import com.scan.scancheckerapp.data.local.ScanRecordDao
import com.scan.scancheckerapp.data.local.ScanStatus
import com.scan.scancheckerapp.data.preferences.SettingsRepository
import com.scan.scancheckerapp.data.remote.ScanUploadRequest
import com.scan.scancheckerapp.data.remote.ScanUploadServiceFactory
import com.scan.scancheckerapp.domain.ocr.OcrTextParser
import com.scan.scancheckerapp.domain.qr.QrCodeService
import com.scan.scancheckerapp.domain.qr.QrIdentity
import com.scan.scancheckerapp.sync.UploadScanWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import retrofit2.HttpException
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

class ScanRepository(
    private val context: Context,
    private val dao: ScanRecordDao,
    private val settingsRepository: SettingsRepository,
    parser: OcrTextParser
) {
    private val qrCodeService = QrCodeService(context)
    private val workManager = WorkManager.getInstance(context)
    private val statusClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .writeTimeout(3, TimeUnit.SECONDS)
        .build()

    fun observeRecords(): Flow<List<ScanRecord>> = dao.observeAll()

    fun observeApiBaseUrl() = settingsRepository.apiBaseUrl

    fun currentApiBaseUrl(): String = settingsRepository.currentApiBaseUrl()

    suspend fun updateApiBaseUrl(value: String) {
        settingsRepository.updateApiBaseUrl(value)
    }

    suspend fun isServerReachable(): Boolean = withContext(Dispatchers.IO) {
        val baseUrl = currentApiBaseUrl()
        if (!settingsRepository.isValidBaseUrl(baseUrl)) {
            return@withContext false
        }

        try {
            val request = Request.Builder()
                .url(baseUrl)
                .get()
                .build()
            statusClient.newCall(request).execute().use { response ->
                response.code in 200..599
            }
        } catch (_: Exception) {
            false
        }
    }

    suspend fun processCapturedImage(tempFile: File, currentFailedAttempts: Int): CaptureOutcome {
        return try {
            val capturedAt = System.currentTimeMillis()
            val originalQrIdentity = try {
                qrCodeService.readIdentity(tempFile)
            } catch (_: Exception) {
                QrIdentity(null, null, null, null)
            }
            val normalizedCapture = ScanFileManager.normalizeCapturedSheet(tempFile, context)
            val normalizedQrIdentity = try {
                qrCodeService.readIdentity(normalizedCapture.file)
            } catch (_: Exception) {
                QrIdentity(null, null, null, null)
            }
            val qrIdentity = originalQrIdentity.mergeWith(normalizedQrIdentity)
            val reviewReasons = listOfNotNull(
                normalizedCapture.needsReviewReason,
                "QR examId was not detected.".takeIf { qrIdentity.examId.isNullOrBlank() },
                "QR sheetId was not detected.".takeIf { qrIdentity.sheetId.isNullOrBlank() }
            ).joinToString(" ").takeIf { it.isNotBlank() }

            val record = persistRecord(
                tempFile = normalizedCapture.file,
                capturedAt = capturedAt,
                qrIdentity = qrIdentity,
                needsReviewReason = reviewReasons,
                status = ScanStatus.PENDING_UPLOAD
            )
            CaptureOutcome.Saved(record, isDraft = reviewReasons != null)
        } catch (exception: Exception) {
            tempFile.delete()
            CaptureOutcome.Failure(
                message = exception.message ?: "Unable to prepare the captured paper."
            )
        }
    }

    suspend fun updateRecordFields(
        recordId: Long,
        studentName: String,
        course: String
    ): UpdateRecordResult {
        val currentRecord = dao.getById(recordId)
            ?: return UpdateRecordResult.Failure("The selected record no longer exists.")

        val trimmedName = studentName.trim()
        val trimmedCourse = course.trim()
        val normalizedName = ScanFileManager.normalizeForDuplicateKey(trimmedName)
        val normalizedCourse = ScanFileManager.normalizeForDuplicateKey(trimmedCourse)
        val hasCompleteFields = normalizedName != null && normalizedCourse != null

        if (hasCompleteFields && isDuplicate(trimmedName, trimmedCourse, recordId)) {
            return UpdateRecordResult.Duplicate("A record for this student and course already exists.")
        }

        val newFileName = if (hasCompleteFields) {
            ScanFileManager.buildFinalFileName(trimmedName, trimmedCourse, currentRecord.capturedAt)
        } else {
            ScanFileManager.buildDraftFileName(currentRecord.capturedAt)
        }

        val renamedFile = ScanFileManager.renameStoredFile(
            context = context,
            currentPath = currentRecord.imagePath,
            targetFileName = newFileName
        ) ?: return UpdateRecordResult.Failure("The stored image file could not be found.")

        val updatedRecord = currentRecord.copy(
            studentName = trimmedName,
            course = trimmedCourse,
            normalizedStudentName = normalizedName,
            normalizedCourse = normalizedCourse,
            imagePath = renamedFile.absolutePath,
            imageFileName = renamedFile.name,
            status = if (hasCompleteFields) ScanStatus.PENDING_UPLOAD else ScanStatus.DRAFT,
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

        if (eligibleRecords.isEmpty()) {
            return UploadRequestResult.NothingToUpload
        }

        eligibleRecords.forEach { record ->
            dao.update(record.copy(status = ScanStatus.UPLOADING, errorMessage = null))

            val workRequest = OneTimeWorkRequestBuilder<UploadScanWorker>()
                .setInputData(workDataOf(UploadScanWorker.KEY_SCAN_ID to record.id))
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()

            workManager.enqueueUniqueWork(
                "upload_scan_${record.id}",
                ExistingWorkPolicy.REPLACE,
                workRequest
            )
        }

        return UploadRequestResult.Scheduled(eligibleRecords.size)
    }

    suspend fun uploadRecord(recordId: Long): ListenableWorker.Result {
        val record = dao.getById(recordId) ?: return ListenableWorker.Result.success()
        val imageFile = File(record.imagePath)
        if (!imageFile.exists()) {
            dao.update(
                record.copy(
                    status = ScanStatus.UPLOAD_FAILED,
                    errorMessage = "The image file is missing from local storage."
                )
            )
            return ListenableWorker.Result.failure()
        }

        val api = ScanUploadServiceFactory.create(currentApiBaseUrl())
        return try {
            val response = api.uploadScan(buildUploadRequest(record, imageFile))

            if (response.isSuccessful) {
                dao.update(
                    record.copy(
                        status = ScanStatus.UPLOADED,
                        remoteReceivedPaperId = response.body()?.id,
                        errorMessage = null
                    )
                )
                ListenableWorker.Result.success()
            } else if (response.code() == 409) {
                dao.update(
                    record.copy(
                        status = ScanStatus.DUPLICATE_REJECTED,
                        errorMessage = "Rejected by web inbox: duplicate image filename."
                    )
                )
                ListenableWorker.Result.success()
            } else {
                dao.update(
                    record.copy(
                        status = ScanStatus.UPLOAD_FAILED,
                        errorMessage = "Upload failed with HTTP ${response.code()}."
                    )
                )
                if (response.code() >= 500) {
                    ListenableWorker.Result.retry()
                } else {
                    ListenableWorker.Result.failure()
                }
            }
        } catch (exception: IOException) {
            dao.update(
                record.copy(
                    status = ScanStatus.UPLOAD_FAILED,
                    errorMessage = exception.message ?: "Network error during upload."
                )
            )
            ListenableWorker.Result.retry()
        } catch (exception: HttpException) {
            dao.update(
                record.copy(
                    status = ScanStatus.UPLOAD_FAILED,
                    errorMessage = exception.message()
                )
            )
            if (exception.code() >= 500) {
                ListenableWorker.Result.retry()
            } else {
                ListenableWorker.Result.failure()
            }
        } catch (exception: Exception) {
            dao.update(
                record.copy(
                    status = ScanStatus.UPLOAD_FAILED,
                    errorMessage = exception.message ?: "Unexpected upload error."
                )
            )
            ListenableWorker.Result.failure()
        }
    }

    private fun buildUploadRequest(record: ScanRecord, imageFile: File): ScanUploadRequest {
        val photoBase64 = Base64.encodeToString(imageFile.readBytes(), Base64.NO_WRAP)
        return ScanUploadRequest(
            sheetId = record.sheetId,
            studentId = record.studentId,
            examId = record.examId,
            imageFileName = record.imageFileName,
            studentName = record.studentName.ifBlank { "Android Scan" },
            course = record.course.ifBlank { "Unassigned Course" },
            age = null,
            imageData = "data:image/jpeg;base64,$photoBase64",
            deviceId = android.os.Build.MODEL,
            qrRawText = record.qrRawText,
            ocrRawText = record.ocrRawText.takeIf { it.isNotBlank() },
            capturedAt = record.capturedAt
        )
    }

    private suspend fun persistRecord(
        tempFile: File,
        capturedAt: Long,
        qrIdentity: QrIdentity,
        needsReviewReason: String?,
        status: ScanStatus
    ): ScanRecord {
        val studentName = qrIdentity.studentName?.trim()?.takeIf { it.isNotBlank() } ?: "Android Scan"
        val course = qrIdentity.course?.trim()?.takeIf { it.isNotBlank() } ?: "Unassigned Course"
        val targetFileName = ScanFileManager.buildInboxFileName(qrIdentity.examId, qrIdentity.sheetId, capturedAt)
        val storedFile = ScanFileManager.moveTempToStoredFile(context, tempFile, targetFileName)
        val record = ScanRecord(
            studentName = studentName,
            course = course,
            normalizedStudentName = null,
            normalizedCourse = null,
            sheetId = qrIdentity.sheetId?.trim()?.takeIf { it.isNotBlank() },
            studentId = qrIdentity.studentId?.trim()?.takeIf { it.isNotBlank() },
            examId = qrIdentity.examId?.trim()?.takeIf { it.isNotBlank() },
            qrRawText = qrIdentity.rawText,
            uploadTarget = "received_papers",
            needsReviewReason = needsReviewReason,
            imagePath = storedFile.absolutePath,
            imageFileName = storedFile.name,
            capturedAt = capturedAt,
            ocrRawText = "",
            status = status,
            errorMessage = null
        )
        val insertedId = dao.insert(record)
        return record.copy(id = insertedId)
    }

    private suspend fun isDuplicate(
        studentName: String,
        course: String,
        excludeRecordId: Long? = null
    ): Boolean {
        val normalizedName = ScanFileManager.normalizeForDuplicateKey(studentName) ?: return false
        val normalizedCourse = ScanFileManager.normalizeForDuplicateKey(course) ?: return false
        return dao.countDuplicates(normalizedName, normalizedCourse, excludeRecordId) > 0
    }

    private fun QrIdentity.mergeWith(fallback: QrIdentity): QrIdentity {
        return QrIdentity(
            sheetId = sheetId ?: fallback.sheetId,
            studentId = studentId ?: fallback.studentId,
            examId = examId ?: fallback.examId,
            rawText = rawText ?: fallback.rawText,
            studentName = studentName ?: fallback.studentName,
            course = course ?: fallback.course,
            age = age ?: fallback.age,
            roomNo = roomNo ?: fallback.roomNo,
            seatNo = seatNo ?: fallback.seatNo,
            entryType = entryType ?: fallback.entryType,
            equityGroup = equityGroup ?: fallback.equityGroup
        )
    }
}
