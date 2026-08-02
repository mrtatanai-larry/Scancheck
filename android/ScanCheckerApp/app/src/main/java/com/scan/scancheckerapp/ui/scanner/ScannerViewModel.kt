package com.scan.scancheckerapp.ui.scanner

import android.app.Application
import android.util.Base64
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.scan.scancheckerapp.ScanCheckerApplication
import com.scan.scancheckerapp.data.remote.ScanUploadRequest
import com.scan.scancheckerapp.domain.scanner.CaptureUploader
import com.scan.scancheckerapp.domain.scanner.ImagePreprocessor
import com.scan.scancheckerapp.domain.scanner.DocumentContourDetector
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class ScannerViewModel(application: Application) : AndroidViewModel(application) {
    private val _uploadState = MutableStateFlow<UploadState>(UploadState.ScanningQR)
    val uploadState: StateFlow<UploadState> = _uploadState

    private val settingsRepository = (application as ScanCheckerApplication).settingsRepository
    private val imagePreprocessor = ImagePreprocessor()
    private val contourDetector = DocumentContourDetector()
    private val preprocessorEnabled = true
    
    private val uploader: CaptureUploader
        get() = CaptureUploader(getApplication(), settingsRepository.currentApiBaseUrl())

    fun onQrDetected(examId: String, qrData: String) {
        if (_uploadState.value is UploadState.ScanningQR) {
            _uploadState.value = UploadState.ReadyToCapture(examId, qrData)
        }
    }

    fun onManualExamId(examId: String) {
        _uploadState.value = UploadState.ReadyToCapture(examId, null)
    }

    fun captureAndUpload(imageCapture: ImageCapture) {
        val currentState = _uploadState.value
        if (currentState !is UploadState.ReadyToCapture) return

        val context = getApplication<Application>()
        val photoFile = File(
            context.cacheDir,
            "scan_${System.currentTimeMillis()}.jpg"
        )

        val outputOptions = ImageCapture.OutputFileOptions.Builder(photoFile).build()

        _uploadState.value = UploadState.Uploading

        imageCapture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    if (preprocessorEnabled) {
                        preprocessAndUpload(photoFile, currentState.examId, currentState.qrData)
                    } else {
                        uploadImage(photoFile, currentState.examId, currentState.qrData)
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    _uploadState.value = UploadState.Error("Capture failed: ${exception.message}")
                }
            }
        )
    }

    /**
     * Preprocess the image (auto-crop + enhance contrast) then upload.
     */
    private fun preprocessAndUpload(file: File, examId: String, qrData: String?) {
        viewModelScope.launch {
            try {
                // Run preprocessing on a background thread
                val result = withContext(Dispatchers.IO) {
                    // Try to detect document corners for auto-crop
                    val corners = detectDocumentCorners(file)
                    imagePreprocessor.preprocess(file, corners)
                }

                // Reject if too blurry
                if (result.isBlurry) {
                    _uploadState.value = UploadState.Error(
                        "Image is too blurry (score: ${result.blurScore.toInt()}). Please retake with steady hands."
                    )
                    file.delete()
                    return@launch
                }

                // Encode preprocessed bytes
                val photoBase64 = Base64.encodeToString(result.processedBytes, Base64.NO_WRAP)
                val imageData = "data:image/jpeg;base64,$photoBase64"

                val request = ScanUploadRequest(
                    sheetId = null,
                    studentId = null,
                    examId = examId,
                    imageFileName = file.name,
                    studentName = "Quick Scan",
                    course = "Unassigned",
                    age = null,
                    imageData = imageData,
                    deviceId = android.os.Build.MODEL,
                    qrRawText = qrData,
                    ocrRawText = null,
                    capturedAt = System.currentTimeMillis()
                )

                val uploadResult = uploader.upload(request)
                uploadResult.onSuccess {
                    _uploadState.value = UploadState.Success
                }.onFailure {
                    _uploadState.value = UploadState.Error("Upload failed: ${it.message}")
                }
            } catch (e: Exception) {
                _uploadState.value = UploadState.Error("Preprocessing failed: ${e.message}")
            } finally {
                file.delete()
            }
        }
    }

    /**
     * Detect document corners for auto-crop using OpenCV contour detection.
     */
    private fun detectDocumentCorners(file: File): List<org.opencv.core.Point>? {
        return try {
            val bitmap = android.graphics.BitmapFactory.decodeFile(file.absolutePath) ?: return null
            val rgba = org.opencv.core.Mat()
            org.opencv.android.Utils.bitmapToMat(bitmap, rgba)
            val result = contourDetector.detect(rgba)
            rgba.release()
            bitmap.recycle()
            result.corners
        } catch (e: Exception) {
            null
        }
    }

    private fun uploadImage(file: File, examId: String, qrData: String?) {
        viewModelScope.launch {
            try {
                // Prepare Base64 image data
                val bytes = file.readBytes()
                val photoBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val imageData = "data:image/jpeg;base64,$photoBase64"

                val request = ScanUploadRequest(
                    sheetId = null,
                    studentId = null,
                    examId = examId,
                    imageFileName = file.name,
                    studentName = "Quick Scan",
                    course = "Unassigned",
                    age = null,
                    imageData = imageData,
                    deviceId = android.os.Build.MODEL,
                    qrRawText = qrData,
                    ocrRawText = null,
                    capturedAt = System.currentTimeMillis()
                )

                val result = uploader.upload(request)
                result.onSuccess {
                    _uploadState.value = UploadState.Success
                    file.delete()
                }.onFailure {
                    _uploadState.value = UploadState.Error("Upload failed: ${it.message}")
                }
            } catch (e: Exception) {
                _uploadState.value = UploadState.Error("Upload preparation failed: ${e.message}")
            }
        }
    }

    fun reset() {
        _uploadState.value = UploadState.ScanningQR
    }
}
