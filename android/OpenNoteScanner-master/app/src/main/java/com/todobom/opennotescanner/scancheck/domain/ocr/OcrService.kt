package com.todobom.opennotescanner.scancheck.domain.ocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class OcrService(
    context: Context,
    private val parser: OcrTextParser
) {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    suspend fun recognize(file: File): ParsedScanText {
        val originalBitmap = BitmapFactory.decodeFile(file.absolutePath)
            ?: error("Unable to decode captured image.")

        val ocrTexts = buildCandidateBitmaps(originalBitmap)
            .map { bitmap ->
                recognizer.process(InputImage.fromBitmap(bitmap, 0)).await().text.trim()
            }
            .filter { it.isNotBlank() }

        return parser.parse(ocrTexts.joinToString(separator = "\n\n"))
    }

    private fun buildCandidateBitmaps(bitmap: Bitmap): List<Bitmap> {
        val header = crop(bitmap, 0.04f, 0.06f, 0.96f, 0.45f)
        val leftInfoPanel = crop(bitmap, 0.12f, 0.24f, 0.60f, 0.47f)

        return listOf(
            scaleBitmap(header, 1.6f),
            scaleBitmap(toGrayscale(header), 1.8f),
            scaleBitmap(leftInfoPanel, 2.1f),
            scaleBitmap(toGrayscale(leftInfoPanel), 2.2f)
        )
    }

    private fun crop(
        bitmap: Bitmap,
        leftFraction: Float,
        topFraction: Float,
        rightFraction: Float,
        bottomFraction: Float
    ): Bitmap {
        val cropLeft = (bitmap.width * leftFraction).toInt().coerceAtLeast(0)
        val cropTop = (bitmap.height * topFraction).toInt().coerceAtLeast(0)
        val cropRight = (bitmap.width * rightFraction).toInt().coerceAtMost(bitmap.width)
        val cropBottom = (bitmap.height * bottomFraction).toInt().coerceAtMost(bitmap.height)
        val cropWidth = (cropRight - cropLeft).coerceAtLeast(1)
        val cropHeight = (cropBottom - cropTop).coerceAtLeast(1)

        return Bitmap.createBitmap(bitmap, cropLeft, cropTop, cropWidth, cropHeight)
    }

    private fun scaleBitmap(bitmap: Bitmap, factor: Float): Bitmap {
        val targetWidth = (bitmap.width * factor).toInt().coerceAtLeast(1)
        val targetHeight = (bitmap.height * factor).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true)
    }

    private fun toGrayscale(bitmap: Bitmap): Bitmap {
        val grayscaleBitmap = Bitmap.createBitmap(
            bitmap.width,
            bitmap.height,
            Bitmap.Config.ARGB_8888
        )
        val canvas = Canvas(grayscaleBitmap)
        val paint = Paint()
        val colorMatrix = ColorMatrix().apply { setSaturation(0f) }
        paint.colorFilter = ColorMatrixColorFilter(colorMatrix)
        canvas.drawBitmap(bitmap, 0f, 0f, paint)
        return grayscaleBitmap
    }

    private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
        addOnSuccessListener { result ->
            continuation.resume(result)
        }.addOnFailureListener { exception ->
            continuation.resumeWithException(exception)
        }
    }
}
