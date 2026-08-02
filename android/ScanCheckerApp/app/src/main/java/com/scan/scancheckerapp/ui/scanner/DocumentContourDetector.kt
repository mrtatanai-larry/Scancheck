package com.scan.scancheckerapp.ui.scanner

import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import kotlin.math.pow
import kotlin.math.sqrt

class DocumentContourDetector {

    data class DetectionResult(
        val corners: List<Point>?,
        val confidence: Double,
        val width: Int,
        val height: Int
    )

    fun detect(rgba: Mat): DetectionResult {
        val width = rgba.width()
        val height = rgba.height()
        
        // 1. Grayscale
        val gray = Mat()
        Imgproc.cvtColor(rgba, gray, Imgproc.COLOR_RGBA2GRAY)

        // 2. Blur to reduce noise
        val blurred = Mat()
        Imgproc.GaussianBlur(gray, blurred, Size(5.0, 5.0), 0.0)

        // 3. Canny Edge Detection
        val edges = Mat()
        Imgproc.Canny(blurred, edges, 75.0, 200.0)

        // 4. Find Contours
        val contours = mutableListOf<MatOfPoint>()
        val hierarchy = Mat()
        Imgproc.findContours(edges, contours, hierarchy, Imgproc.RETR_LIST, Imgproc.CHAIN_APPROX_SIMPLE)

        var maxContour: MatOfPoint2f? = null
        var maxArea = -1.0

        for (contour in contours) {
            val area = Imgproc.contourArea(contour)
            if (area < (width * height * 0.1)) continue // Ignore small contours

            val contour2f = MatOfPoint2f(*contour.toArray())
            val perimeter = Imgproc.arcLength(contour2f, true)
            val approx = MatOfPoint2f()
            Imgproc.approxPolyDP(contour2f, approx, 0.02 * perimeter, true)

            if (approx.total() == 4L) {
                if (area > maxArea) {
                    maxArea = area
                    maxContour = approx
                }
            }
        }

        val result = if (maxContour != null) {
            val corners = sortCorners(maxContour.toList())
            DetectionResult(corners, maxArea / (width * height), width, height)
        } else {
            DetectionResult(null, 0.0, width, height)
        }

        // Cleanup
        gray.release()
        blurred.release()
        edges.release()
        hierarchy.release()
        
        return result
    }

    private fun sortCorners(points: List<Point>): List<Point> {
        val sortedBySum = points.sortedBy { it.x + it.y }
        val topLeft = sortedBySum[0]
        val bottomRight = sortedBySum[3]

        val sortedByDiff = points.sortedBy { it.y - it.x }
        val topRight = sortedByDiff[0]
        val bottomLeft = sortedByDiff[3]

        return listOf(topLeft, topRight, bottomRight, bottomLeft)
    }
}
