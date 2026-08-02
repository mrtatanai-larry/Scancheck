package com.scan.scancheckerapp.domain.scanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.opencv.android.Utils
import org.opencv.core.*
import org.opencv.imgproc.Imgproc
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Preprocesses captured scan images before upload:
 * - Blur detection (skip/reject blurry images)
 * - Auto-crop using document boundary detection
 * - Contrast normalization (CLAHE)
 * - JPEG compression optimization
 */
class ImagePreprocessor {

    data class PreprocessResult(
        val processedBytes: ByteArray,
        val wasCropped: Boolean,
        val wasEnhanced: Boolean,
        val blurScore: Float,
        val isBlurry: Boolean
    )

    /**
     * Preprocess a captured image file for upload.
     * Returns the processed image bytes ready for Base64 encoding.
     */
    fun preprocess(file: File, corners: List<org.opencv.core.Point>? = null): PreprocessResult {
        // Load image
        val src = BitmapFactory.decodeFile(file.absolutePath) ?: return fallback(file)

        val rgba = Mat()
        Utils.bitmapToMat(src, rgba)

        // 1. Blur detection
        val gray = Mat()
        Imgproc.cvtColor(rgba, gray, Imgproc.COLOR_RGBA2GRAY)

        val blurScore = detectBlur(gray)
        val isBlurry = blurScore < 50f

        // 2. Auto-crop if corners are available
        var wasCropped = false
        var processed = rgba

        if (corners != null && corners.size == 4) {
            val cropped = autoCrop(rgba, corners)
            if (cropped != null) {
                processed = cropped
                wasCropped = true
            }
        }

        // 3. Contrast normalization (CLAHE)
        val enhanced = enhanceContrast(processed)
        var wasEnhanced = true
        if (enhanced == null) {
            wasEnhanced = false
        }

        // 4. Encode to JPEG
        val resultMat = enhanced ?: processed
        val resultBitmap = Bitmap.createBitmap(
            resultMat.cols(), resultMat.rows(),
            Bitmap.Config.ARGB_8888
        )
        Utils.matToBitmap(resultMat, resultBitmap)

        val outputStream = ByteArrayOutputStream()
        resultBitmap.compress(Bitmap.CompressFormat.JPEG, 92, outputStream)
        val bytes = outputStream.toByteArray()

        // Cleanup
        if (processed !== rgba) processed.release()
        if (enhanced != null && enhanced !== processed && enhanced !== rgba) enhanced.release()
        rgba.release()
        gray.release()
        src.recycle()
        resultBitmap.recycle()

        return PreprocessResult(
            processedBytes = bytes,
            wasCropped = wasCropped,
            wasEnhanced = wasEnhanced,
            blurScore = blurScore,
            isBlurry = isBlurry
        )
    }

    /**
     * Detect blur using Laplacian variance.
     * Returns the variance: < 100 = blurry, > 200 = sharp.
     */
    private fun detectBlur(gray: Mat): Float {
        val laplacian = Mat()
        Imgproc.Laplacian(gray, laplacian, CvType.CV_64F)

        // Compute mean and std of Laplacian
        val mean = MatOfDouble()
        val stdv = MatOfDouble()
        Core.meanStdDev(laplacian, mean, stdv)

        val variance = if (!stdv.empty()) {
            val dev = stdv.get(0, 0)[0]
            (dev * dev).toFloat()
        } else 0f

        laplacian.release()
        mean.release()
        stdv.release()
        return variance
    }

    /**
     * Auto-crop the image using detected document corners.
     * Applies a perspective transform to flatten the document.
     */
    private fun autoCrop(rgba: Mat, corners: List<org.opencv.core.Point>): Mat? {
        if (corners.size != 4) return null

        // Calculate target dimensions
        val widthA = Math.sqrt(
            Math.pow(corners[2].x - corners[3].x, 2.0) +
            Math.pow(corners[2].y - corners[3].y, 2.0)
        )
        val widthB = Math.sqrt(
            Math.pow(corners[1].x - corners[0].x, 2.0) +
            Math.pow(corners[1].y - corners[0].y, 2.0)
        )
        val maxWidth = Math.max(widthA, widthB).toInt()

        val heightA = Math.sqrt(
            Math.pow(corners[1].x - corners[2].x, 2.0) +
            Math.pow(corners[1].y - corners[2].y, 2.0)
        )
        val heightB = Math.sqrt(
            Math.pow(corners[0].x - corners[3].x, 2.0) +
            Math.pow(corners[0].y - corners[3].y, 2.0)
        )
        val maxHeight = Math.max(heightA, heightB).toInt()

        if (maxWidth <= 0 || maxHeight <= 0) return null

        // Source and destination points
        val srcPoints = MatOfPoint2f(*corners.toTypedArray())
        val dstPoints = MatOfPoint2f(
            org.opencv.core.Point(0.0, 0.0),
            org.opencv.core.Point(maxWidth.toDouble(), 0.0),
            org.opencv.core.Point(maxWidth.toDouble(), maxHeight.toDouble()),
            org.opencv.core.Point(0.0, maxHeight.toDouble())
        )

        // Perspective transform
        val matrix = Imgproc.getPerspectiveTransform(srcPoints, dstPoints)
        val warped = Mat()
        Imgproc.warpPerspective(
            rgba, warped, matrix,
            Size(maxWidth.toDouble(), maxHeight.toDouble()),
            Imgproc.INTER_LINEAR
        )

        matrix.release()
        srcPoints.release()
        dstPoints.release()

        return warped
    }

    /**
     * Enhance image contrast using CLAHE.
     * Returns a new Mat or null if enhancement fails.
     */
    private fun enhanceContrast(rgba: Mat): Mat? {
        if (rgba.empty()) return null

        val gray = Mat()
        Imgproc.cvtColor(rgba, gray, Imgproc.COLOR_RGBA2GRAY)

        // Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
        val clahe = Imgproc.createCLAHE(2.0, Size(8.0, 8.0))
        val enhanced = Mat()
        clahe.apply(gray, enhanced)

        // Convert back to RGBA
        val result = Mat()
        Imgproc.cvtColor(enhanced, result, Imgproc.COLOR_GRAY2RGBA)

        gray.release()
        enhanced.release()
        // No explicit dispose() method for CLAHE in OpenCV Android Java API.
        // It will be handled by garbage collection.

        return result
    }

    private fun fallback(file: File): PreprocessResult {
        val bytes = file.readBytes()
        return PreprocessResult(
            processedBytes = bytes,
            wasCropped = false,
            wasEnhanced = false,
            blurScore = 0f,
            isBlurry = false
        )
    }
}
