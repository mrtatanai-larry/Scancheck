package com.scan.scancheckerapp.ui.scanner

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import org.opencv.android.Utils
import org.opencv.core.Mat
import org.opencv.core.Point
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class DocumentScannerAnalyzer(
    private val onDocumentDetected: (List<Point>?, Int, Int) -> Unit
) : ImageAnalysis.Analyzer {

    private val detector = DocumentContourDetector()
    private val smoother = CornerSmoother(bufferSize = 6)
    
    // Auto-capture logic
    private var lastStableCorners: List<Point>? = null
    private var stableSince: Long = 0
    private val stabilityThreshold = 1500L // 1.5 seconds

    override fun analyze(image: ImageProxy) {
        val bitmap = image.toBitmap() ?: return
        val rgba = Mat()
        Utils.bitmapToMat(bitmap, rgba)

        val result = detector.detect(rgba)
        val smoothedCorners = smoother.smooth(result.corners)

        onDocumentDetected(smoothedCorners, result.width, result.height)

        rgba.release()
        image.close()
    }
}
