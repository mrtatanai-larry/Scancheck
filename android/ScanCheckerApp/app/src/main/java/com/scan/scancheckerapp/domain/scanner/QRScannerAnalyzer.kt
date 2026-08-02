package com.scan.scancheckerapp.domain.scanner

import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

import android.util.Log

class QRScannerAnalyzer(
    private val onQrDetected: (String, String) -> Unit
) : ImageAnalysis.Analyzer {

    private val scanner = BarcodeScanning.getClient()

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            scanner.process(image)
                .addOnSuccessListener { barcodes ->
                    for (barcode in barcodes) {
                        if (barcode.valueType == Barcode.TYPE_TEXT || barcode.valueType == Barcode.TYPE_WIFI || barcode.valueType == Barcode.TYPE_URL) {
                            val rawValue = barcode.rawValue ?: continue
                            Log.d("QRDetect", "Detected QR raw: $rawValue")
                            val examId = extractExamId(rawValue)
                            onQrDetected(examId, rawValue)
                        }
                    }
                }
                .addOnCompleteListener {
                    imageProxy.close()
                }
        } else {
            imageProxy.close()
        }
    }

    private fun extractExamId(qrData: String): String {
        // Simple extraction logic, can be refined. 
        // If it's JSON, try to parse. If it's key=value, find examId.
        // For now, if no clear pattern, return the whole string as examId or some default.
        return if (qrData.contains("examId=")) {
            qrData.substringAfter("examId=").substringBefore("&").substringBefore("\n")
        } else if (qrData.contains("\"examId\":")) {
            qrData.substringAfter("\"examId\":").substringAfter("\"").substringBefore("\"")
        } else {
            qrData
        }
    }
}
