package com.scan.scancheckerapp.data.repository

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Log
import com.scan.scancheckerapp.domain.scanner.DocumentCornerDetector
import com.scan.scancheckerapp.domain.scanner.DocumentDetectionInfo
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object ScanFileManager {
    private const val FINAL_SCAN_DIR = "scans"
    private const val TEMP_SCAN_DIR = "scan_temp"
    private val timestampFormatter = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)

    data class NormalizedCapture(
        val file: File,
        val needsReviewReason: String?
    )

    fun createTempCaptureFile(context: Context): File {
        val tempDir = File(context.cacheDir, TEMP_SCAN_DIR).apply { mkdirs() }
        return File.createTempFile("capture_", ".jpg", tempDir)
    }

    fun buildFinalFileName(studentName: String, course: String, capturedAt: Long): String {
        return "${slugify(studentName)}_${slugify(course)}_${formatTimestamp(capturedAt)}.jpg"
    }

    fun buildDraftFileName(capturedAt: Long): String {
        return "draft_${formatTimestamp(capturedAt)}.jpg"
    }

    fun buildInboxFileName(examId: String?, sheetId: String?, capturedAt: Long): String {
        val exam = slugify(examId.orEmpty()).takeIf { it != "unknown" } ?: "unknown_exam"
        val sheet = slugify(sheetId.orEmpty()).takeIf { it != "unknown" } ?: "unknown_sheet"
        return "sheet_${exam}_${sheet}_${formatTimestamp(capturedAt)}.jpg"
    }

    // ---------------------------------------------------------------
    //  Normalize the captured JPEG for upload.
    //
    //  Pipeline:
    //    1. Decode full-res JPEG → Bitmap
    //    2. Orient / rotate to upright portrait (no scale change)
    //    3. Run DocumentCornerDetector for **validation only**
    //       (checks corners visible, blur, brightness, tilt)
    //    4. Save oriented full-res bitmap back to JPEG
    //    5. NO Android‑side warp or resize — let the backend handle
    //       form detection + perspective correction.
    // ---------------------------------------------------------------
    fun normalizeCapturedSheet(tempFile: File, context: Context? = null): NormalizedCapture {
        saveDebugOriginal(tempFile, context)

        val source = BitmapFactory.decodeFile(tempFile.absolutePath)
            ?: return NormalizedCapture(tempFile, "Captured image could not be decoded.")

        val portraitSource = orientForOmr(source)

        return try {
            val detection = DocumentCornerDetector.detectWithInfo(portraitSource, requireHotArea = false)
            val exifOrientation = readExifOrientation(tempFile)

            Log.d("Normalize", buildDebugLog(tempFile, portraitSource, exifOrientation, detection))

            val needsReviewReason = buildNeedsReviewReason(detection)

            // Save oriented full-res bitmap to tempFile (NO warp, NO resize)
            writeJpeg(portraitSource, tempFile)

            saveDebugNormalized(portraitSource, context, tempFile)
            saveDebugFinal(tempFile, context)

            NormalizedCapture(
                file = tempFile,
                needsReviewReason = needsReviewReason
            )
        } finally {
            if (portraitSource !== source) portraitSource.recycle()
            source.recycle()
        }
    }

    private fun buildDebugLog(
        file: File,
        bitmap: Bitmap,
        exifOrientation: Int,
        detection: DocumentDetectionInfo
    ): String {
        val sb = StringBuilder()
        sb.append("source=android_image_capture")
        sb.append(" file=${file.absolutePath}")
        sb.append(" width=${bitmap.width}")
        sb.append(" height=${bitmap.height}")
        sb.append(" fileSize=${file.length()}")
        sb.append(" exifOrientation=$exifOrientation")
        sb.append(" rotation=0")
        sb.append(" resized=false")
        sb.append(" warped=false")
        sb.append(" conf=${"%.3f".format(detection.confidence)}")
        sb.append(" blur=${"%.1f".format(detection.blurScore)}")
        sb.append(" bright=${"%.1f".format(detection.brightness)}")
        sb.append(" tilt=${"%.1f".format(detection.tiltDegrees)}")
        sb.append(" corners=${detection.corners?.size ?: 0}")
        sb.append(" acceptable=${detection.isAcceptable}")
        return sb.toString()
    }

    private fun buildNeedsReviewReason(
        detection: DocumentDetectionInfo
    ): String? {
        val reasons = mutableListOf<String>()
        if (detection.corners?.size != 4) {
            reasons.add("Document corners not fully visible (${detection.corners?.size ?: 0}/4).")
        }
        if (!detection.isAcceptable) {
            val parts = mutableListOf<String>()
            if (detection.confidence < 0.1) parts.add("low confidence (${"%.3f".format(detection.confidence)})")
            if (detection.blurScore < 30.0) parts.add("blurry (${"%.1f".format(detection.blurScore)})")
            if (detection.brightness < 80.0) parts.add("too dark (${"%.1f".format(detection.brightness)})")
            if (detection.tiltDegrees > 15.0) parts.add("tilted ${"%.1f".format(detection.tiltDegrees)}° > 15°")
            if (parts.isNotEmpty()) reasons.add(parts.joinToString(", "))
        }
        return reasons.takeIf { it.isNotEmpty() }?.joinToString(" ")
    }

    private fun readExifOrientation(file: File): Int {
        return try {
            ExifInterface(file.absolutePath).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            )
        } catch (_: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    // ---------------------------------------------------------------
    //  Debug file saving
    // ---------------------------------------------------------------
    private fun debugDir(context: Context?): File? {
        if (context == null) return null
        return File(context.cacheDir, "debug_scans").apply { mkdirs() }
    }

    private fun saveDebugOriginal(tempFile: File, context: Context?) {
        val dir = debugDir(context) ?: return
        val dest = File(dir, "original_capture.jpg")
        tempFile.copyTo(dest, overwrite = true)
        Log.d("Normalize", "Debug original saved: ${dest.absolutePath}")
    }

    private fun saveDebugNormalized(bitmap: Bitmap, context: Context?, tempFile: File) {
        val dir = debugDir(context) ?: return
        val dest = File(dir, "normalized_capture.jpg")
        writeJpeg(bitmap, dest)
        Log.d("Normalize", "Debug normalized saved: ${dest.absolutePath} (${bitmap.width}x${bitmap.height})")
    }

    private fun saveDebugFinal(tempFile: File, context: Context?) {
        val dir = debugDir(context) ?: return
        val dest = File(dir, "final_uploaded.jpg")
        tempFile.copyTo(dest, overwrite = true)
        Log.d("Normalize", "Debug final saved: ${dest.absolutePath}")
    }

    fun normalizeForDuplicateKey(value: String?): String? {
        return value
            ?.trim()
            ?.lowercase(Locale.US)
            ?.replace(Regex("\\s+"), " ")
            ?.takeIf { it.isNotBlank() }
    }

    fun moveTempToStoredFile(context: Context, tempFile: File, targetFileName: String): File {
        val targetDir = File(context.filesDir, FINAL_SCAN_DIR).apply { mkdirs() }
        val targetFile = File(targetDir, targetFileName)
        tempFile.copyTo(targetFile, overwrite = true)
        if (tempFile.absolutePath != targetFile.absolutePath) {
            tempFile.delete()
        }
        return targetFile
    }

    fun renameStoredFile(context: Context, currentPath: String, targetFileName: String): File? {
        val currentFile = File(currentPath)
        if (!currentFile.exists()) {
            return null
        }

        val targetDir = File(context.filesDir, FINAL_SCAN_DIR).apply { mkdirs() }
        val targetFile = File(targetDir, targetFileName)
        if (currentFile.absolutePath == targetFile.absolutePath) {
            return currentFile
        }

        currentFile.copyTo(targetFile, overwrite = true)
        currentFile.delete()
        return targetFile
    }

    fun deleteStoredFile(path: String) {
        File(path).delete()
    }

    private fun slugify(value: String): String {
        return value
            .trim()
            .lowercase(Locale.US)
            .replace(Regex("[^a-z0-9]+"), "_")
            .trim('_')
            .ifBlank { "unknown" }
    }

    private fun formatTimestamp(capturedAt: Long): String = timestampFormatter.format(Date(capturedAt))

    private fun writeJpeg(bitmap: Bitmap, target: File) {
        FileOutputStream(target, false).use { output ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output)
        }
    }

    private fun orientForOmr(bitmap: Bitmap): Bitmap {
        if (bitmap.height >= bitmap.width) return bitmap
        val matrix = Matrix().apply { postRotate(90f) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun hasVisibleInk(bitmap: Bitmap): Boolean {
        var darkSamples = 0
        var totalSamples = 0
        val stepX = (bitmap.width / 80).coerceAtLeast(1)
        val stepY = (bitmap.height / 120).coerceAtLeast(1)

        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val pixel = bitmap.getPixel(x, y)
                val luminance = (Color.red(pixel) + Color.green(pixel) + Color.blue(pixel)) / 3
                if (luminance < 210) darkSamples++
                totalSamples++
                x += stepX
            }
            y += stepY
        }

        return totalSamples > 0 && darkSamples.toDouble() / totalSamples.toDouble() > 0.01
    }
}
