package com.scan.scancheckerapp.ui.scanner

import android.graphics.Bitmap
import org.opencv.android.Utils
import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sqrt

class PerspectiveTransformer {

    fun transform(bitmap: Bitmap, corners: List<Point>): Bitmap {
        val src = Mat()
        Utils.bitmapToMat(bitmap, src)

        // 1. Calculate target dimensions
        val widthA = sqrt((corners[2].x - corners[3].x).pow(2.0) + (corners[2].y - corners[3].y).pow(2.0))
        val widthB = sqrt((corners[1].x - corners[0].x).pow(2.0) + (corners[1].y - corners[0].y).pow(2.0))
        val maxWidth = max(widthA, widthB).toInt()

        val heightA = sqrt((corners[1].x - corners[2].x).pow(2.0) + (corners[1].y - corners[2].y).pow(2.0))
        val heightB = sqrt((corners[0].x - corners[3].x).pow(2.0) + (corners[0].y - corners[3].y).pow(2.0))
        val maxHeight = max(heightA, heightB).toInt()

        // 2. Define source and destination points
        val srcPoints = MatOfPoint2f(*corners.toTypedArray())
        val dstPoints = MatOfPoint2f(
            Point(0.0, 0.0),
            Point(maxWidth.toDouble(), 0.0),
            Point(maxWidth.toDouble(), maxHeight.toDouble()),
            Point(0.0, maxHeight.toDouble())
        )

        // 3. Apply perspective transform
        val transformMatrix = Imgproc.getPerspectiveTransform(srcPoints, dstPoints)
        val transformed = Mat()
        Imgproc.warpPerspective(src, transformed, transformMatrix, Size(maxWidth.toDouble(), maxHeight.toDouble()))

        // 4. Enhance for OCR
        val enhanced = enhance(transformed)

        // 5. Convert back to Bitmap
        val resultBitmap = Bitmap.createBitmap(maxWidth, maxHeight, Bitmap.Config.ARGB_8888)
        Utils.matToBitmap(enhanced, resultBitmap)

        // Cleanup
        src.release()
        transformed.release()
        enhanced.release()
        transformMatrix.release()

        return resultBitmap
    }

    private fun enhance(src: Mat): Mat {
        val gray = Mat()
        Imgproc.cvtColor(src, gray, Imgproc.COLOR_RGBA2GRAY)

        // Adaptive Thresholding for B&W effect
        val thresholded = Mat()
        Imgproc.adaptiveThreshold(
            gray,
            thresholded,
            255.0,
            Imgproc.ADAPTIVE_THRESH_GAUSSIAN_C,
            Imgproc.THRESH_BINARY,
            11,
            2.0
        )

        // Denoise
        val denoised = Mat()
        Imgproc.medianBlur(thresholded, denoised, 3)

        gray.release()
        thresholded.release()

        return denoised
    }

    private fun Double.pow(n: Double) = Math.pow(this, n)
}
