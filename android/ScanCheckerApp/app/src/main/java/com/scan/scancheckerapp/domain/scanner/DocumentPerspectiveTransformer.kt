package com.scan.scancheckerapp.domain.scanner

import android.graphics.Bitmap
import org.opencv.android.Utils
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Size
import org.opencv.imgproc.Imgproc
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sqrt

object DocumentPerspectiveTransformer {
    fun transform(
        bitmap: Bitmap,
        corners: List<Point>
    ): Bitmap {
        require(corners.size == 4) { "A document transform requires exactly four corners." }

        val widthA = distance(corners[2], corners[3])
        val widthB = distance(corners[1], corners[0])
        val outputWidth = max(widthA, widthB).toInt().coerceAtLeast(1)

        val heightA = distance(corners[1], corners[2])
        val heightB = distance(corners[0], corners[3])
        val outputHeight = max(heightA, heightB).toInt().coerceAtLeast(1)

        return transform(bitmap, corners, outputWidth, outputHeight)
    }

    fun transform(
        bitmap: Bitmap,
        corners: List<Point>,
        outputWidth: Int,
        outputHeight: Int
    ): Bitmap {
        require(corners.size == 4) { "A document transform requires exactly four corners." }

        val src = Mat()
        val transformed = Mat(outputHeight, outputWidth, CvType.CV_8UC4)
        Utils.bitmapToMat(bitmap, src)

        val srcPoints = MatOfPoint2f(*corners.toTypedArray())
        val dstPoints = MatOfPoint2f(
            Point(0.0, 0.0),
            Point(outputWidth.toDouble(), 0.0),
            Point(outputWidth.toDouble(), outputHeight.toDouble()),
            Point(0.0, outputHeight.toDouble())
        )

        val transformMatrix = Imgproc.getPerspectiveTransform(srcPoints, dstPoints)
        return try {
            Imgproc.warpPerspective(
                src,
                transformed,
                transformMatrix,
                Size(outputWidth.toDouble(), outputHeight.toDouble()),
                Imgproc.INTER_CUBIC
            )
            Bitmap.createBitmap(outputWidth, outputHeight, Bitmap.Config.ARGB_8888).also {
                Utils.matToBitmap(transformed, it)
            }
        } finally {
            transformMatrix.release()
            src.release()
            transformed.release()
            srcPoints.release()
            dstPoints.release()
        }
    }

    private fun distance(first: Point, second: Point): Double {
        val dx = first.x - second.x
        val dy = first.y - second.y
        return sqrt(dx.pow(2.0) + dy.pow(2.0))
    }
}
