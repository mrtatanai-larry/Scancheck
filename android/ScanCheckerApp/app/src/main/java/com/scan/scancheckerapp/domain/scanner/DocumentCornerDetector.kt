package com.scan.scancheckerapp.domain.scanner

import android.graphics.Bitmap
import android.util.Log
import org.opencv.android.Utils
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfDouble
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max

object DocumentCornerDetector {
    private const val DETECTION_HEIGHT = 500.0
    const val DEFAULT_DOCUMENT_ASPECT_RATIO = 1632.0 / 2496.0

    data class DetectionResult(
        val corners: List<Point>?,
        val confidence: Double,
        val width: Int,
        val height: Int
    )

    fun detect(
        bitmap: Bitmap,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO,
        requireHotArea: Boolean = true
    ): DetectionResult {
        val src = Mat()
        Utils.bitmapToMat(bitmap, src)
        return try {
            detect(src, documentAspectRatio, requireHotArea)
        } finally {
            src.release()
        }
    }

    fun detectWithInfo(
        src: Mat,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO,
        requireHotArea: Boolean = true
    ): DocumentDetectionInfo {
        val result = detect(src, documentAspectRatio, requireHotArea)
        return computeQualityInfo(src, result, result.corners)
    }

    fun detectWithInfo(
        bitmap: Bitmap,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO,
        requireHotArea: Boolean = true
    ): DocumentDetectionInfo {
        val src = Mat()
        Utils.bitmapToMat(bitmap, src)
        return try {
            detectWithInfo(src, documentAspectRatio, requireHotArea)
        } finally {
            src.release()
        }
    }

    fun detect(
        src: Mat,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO,
        requireHotArea: Boolean = true
    ): DetectionResult {
        // Log input dimensions
        Log.d("DocumentDetect", "detect called with src ${src.width()}x${src.height()}")

        if (src.empty()) return DetectionResult(null, 0.0, 0, 0)

        val sourceWidth = src.width()
        val sourceHeight = src.height()
        val ratio = sourceHeight / DETECTION_HEIGHT
        val detectionWidth = max(1.0, sourceWidth / ratio).toInt()
        val detectionHeight = max(1.0, sourceHeight / ratio).toInt()
        val detectionSize = Size(detectionWidth.toDouble(), detectionHeight.toDouble())

        val resized = Mat(detectionSize, CvType.CV_8UC4)
        val gray = Mat()
        val edges = Mat()
        val hierarchy = Mat()

        return try {
            Imgproc.resize(src, resized, detectionSize)
            when (resized.channels()) {
                4 -> Imgproc.cvtColor(resized, gray, Imgproc.COLOR_RGBA2GRAY)
                3 -> Imgproc.cvtColor(resized, gray, Imgproc.COLOR_RGB2GRAY)
                else -> resized.copyTo(gray)
            }
            Imgproc.GaussianBlur(gray, gray, Size(5.0, 5.0), 0.0)
            Imgproc.Canny(gray, edges, 75.0, 200.0)

            val contours = mutableListOf<MatOfPoint>()
            try {
                Imgproc.findContours(edges, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)
                contours.sortByDescending { Imgproc.contourArea(it) }

                val quad = findDocumentQuad(contours, detectionSize, documentAspectRatio, requireHotArea)
                val confidence = quad?.let { Imgproc.contourArea(it.contour) / (detectionWidth * detectionHeight) } ?: 0.0
                if (quad == null) {
                    DetectionResult(null, confidence, sourceWidth, sourceHeight)
                } else {
                    DetectionResult(
                        corners = quad.points.map { Point(it.x * ratio, it.y * ratio) },
                        confidence = confidence.coerceIn(0.0, 1.0),
                        width = sourceWidth,
                        height = sourceHeight
                    )
                }
            } finally {
                contours.forEach { it.release() }
            }
        } finally {
            resized.release()
            gray.release()
            edges.release()
            hierarchy.release()
        }
    }

    // After computing detection result, we also compute quality metrics.
    private fun computeQualityInfo(
        src: Mat,
        detectionResult: DetectionResult,
        corners: List<Point>?
    ): DocumentDetectionInfo {
        // Blur score: variance of Laplacian on grayscale image
        val gray = Mat()
        Imgproc.cvtColor(src, gray, Imgproc.COLOR_RGBA2GRAY)
        val laplacian = Mat()
        Imgproc.Laplacian(gray, laplacian, CvType.CV_64F)
        val mean = MatOfDouble()
        val stddev = MatOfDouble()
        Core.meanStdDev(laplacian, mean, stddev)
        val blurScore = stddev.get(0, 0)[0]
        gray.release()
        laplacian.release()

        // Brightness: average luminance over sampled grid (same as hasVisibleInk but compute mean)
        var totalLuminance = 0L
        var totalSamples = 0L
        val stepX = (src.width() / 80).coerceAtLeast(1)
        val stepY = (src.height() / 120).coerceAtLeast(1)
        var y = 0
        while (y < src.height()) {
            var x = 0
            while (x < src.width()) {
                val pixel = src.get(y, x) // returns double[] (B,G,R,A) for RGBA
                // Compute luminance (simple average of R,G,B)
                val r = pixel[0]
                val g = pixel[1]
                val b = pixel[2]
                totalLuminance += ((r + g + b) / 3).toLong()
                totalSamples++
                x += stepX
            }
            y += stepY
        }
        val brightness = if (totalSamples > 0) totalLuminance.toDouble() / totalSamples else 0.0

        // Tilt: angle of top edge (first two sorted points) relative to horizontal
        val tiltDegrees = corners?.let {
            if (it.size >= 2) {
                val dx = it[1].x - it[0].x
                val dy = it[1].y - it[0].y
                val radians = atan2(dy, dx)
                kotlin.math.abs(Math.toDegrees(radians))
            } else 0.0
        } ?: 0.0

        // Acceptability thresholds
        val minConfidence = 0.1
        val minBlur = 30.0 // higher is sharper, require >=
        val minBrightness = 80.0
        val maxTilt = 15.0
        val acceptable = detectionResult.confidence >= minConfidence &&
                blurScore >= minBlur &&
                brightness >= minBrightness &&
                tiltDegrees <= maxTilt &&
                corners?.size == 4

        Log.d(
            "DocumentDetect",
            "conf=${detectionResult.confidence} blur=$blurScore bright=$brightness tilt=$tiltDegrees acceptable=$acceptable"
        )
        return DocumentDetectionInfo(
            corners = corners,
            confidence = detectionResult.confidence,
            blurScore = blurScore,
            brightness = brightness,
            tiltDegrees = tiltDegrees,
            isAcceptable = acceptable
        )
    }

    private fun findDocumentQuad(
        contours: List<MatOfPoint>,
        size: Size,
        documentAspectRatio: Double,
        requireHotArea: Boolean
    ): Quad? {
        for (contour in contours) {
            val contour2f = MatOfPoint2f(*contour.toArray())
            try {
                val perimeter = Imgproc.arcLength(contour2f, true)
                val approx = MatOfPoint2f()
                try {
                    Imgproc.approxPolyDP(contour2f, approx, 0.02 * perimeter, true)
                    val points = approx.toArray()
                    if (points.size == 4) {
                        val sorted = sortPoints(points.toList())
                        val quad = Quad(contour, sorted)
                        if (!requireHotArea || insideHotArea(sorted, size, documentAspectRatio)) return quad
                    }
                } finally {
                    approx.release()
                }
            } finally {
                contour2f.release()
            }
        }
        return null
    }

    private fun sortPoints(points: List<Point>): List<Point> {
        val topLeft = points.minBy { it.x + it.y }
        val bottomRight = points.maxBy { it.x + it.y }
        val topRight = points.minBy { it.y - it.x }
        val bottomLeft = points.maxBy { it.y - it.x }
        return listOf(topLeft, topRight, bottomRight, bottomLeft)
    }

    fun insideHotArea(
        points: List<Point>,
        size: Size,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO
    ): Boolean {
        val hotArea = getHotArea(size.width, size.height, documentAspectRatio)
        return points[0].x <= hotArea.left &&
            points[0].y <= hotArea.top &&
            points[1].x >= hotArea.right &&
            points[1].y <= hotArea.top &&
            points[2].x >= hotArea.right &&
            points[2].y >= hotArea.bottom &&
            points[3].x <= hotArea.left &&
            points[3].y >= hotArea.bottom
    }

    fun getHotArea(
        width: Double,
        height: Double,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO
    ): HotArea {
        if (documentAspectRatio == 0.0) {
            val baseMeasure = height / 4.0
            return HotArea(
                left = width / 2.0 - baseMeasure,
                top = baseMeasure,
                right = width / 2.0 + baseMeasure,
                bottom = height - baseMeasure
            )
        }

        val area = getDocumentArea(width, height, documentAspectRatio)
        val hotOffset = height / 10.0
        return HotArea(
            left = area.left + hotOffset,
            top = area.top + hotOffset,
            right = area.right - hotOffset,
            bottom = area.bottom - hotOffset
        )
    }

    fun getDocumentArea(
        width: Double,
        height: Double,
        documentAspectRatio: Double = DEFAULT_DOCUMENT_ASPECT_RATIO
    ): HotArea {
        val imageRatio = width / height
        return if (imageRatio >= documentAspectRatio) {
            val documentHeight = height - height / 10.0
            val documentWidth = documentHeight * documentAspectRatio
            val top = height / 20.0
            HotArea(
                left = (width - documentWidth) / 2.0,
                top = top,
                right = width - (width - documentWidth) / 2.0,
                bottom = height - top
            )
        } else {
            val documentWidth = width - width / 5.0
            val documentHeight = documentWidth / documentAspectRatio
            val left = width / 10.0
            HotArea(
                left = left,
                top = (height - documentHeight) / 2.0,
                right = width - left,
                bottom = height - (height - documentHeight) / 2.0
            )
        }
    }

    private data class Quad(
        val contour: MatOfPoint,
        val points: List<Point>
    )

    data class HotArea(
        val left: Double,
        val top: Double,
        val right: Double,
        val bottom: Double
    )
}
