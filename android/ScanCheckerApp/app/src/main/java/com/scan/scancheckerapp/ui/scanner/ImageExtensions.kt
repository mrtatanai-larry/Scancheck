package com.scan.scancheckerapp.ui.scanner

import android.graphics.*
import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer
import java.io.ByteArrayOutputStream

fun ImageProxy.toBitmap(): Bitmap? {
    if (format == PixelFormat.RGBA_8888 || planes.size == 1) {
        return rotateIfNeeded(copyRgbaPlaneToBitmap())
    }

    if (planes.size < 3) return null

    val yuvImage = YuvImage(toNv21(), ImageFormat.NV21, width, height, null)
    val out = ByteArrayOutputStream()
    yuvImage.compressToJpeg(Rect(0, 0, width, height), 100, out)
    val imageBytes = out.toByteArray()
    val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size) ?: return null
    
    return rotateIfNeeded(bitmap)
}

private fun ImageProxy.copyRgbaPlaneToBitmap(): Bitmap {
    val plane = planes[0]
    val buffer = plane.buffer.duplicate()
    buffer.rewind()

    val pixelStride = plane.pixelStride.coerceAtLeast(4)
    val paddedWidth = plane.rowStride / pixelStride
    val paddedBitmap = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
    paddedBitmap.copyPixelsFromBuffer(buffer)

    if (paddedWidth == width) {
        return paddedBitmap
    }

    val croppedBitmap = Bitmap.createBitmap(paddedBitmap, 0, 0, width, height)
    paddedBitmap.recycle()
    return croppedBitmap
}

private fun ImageProxy.rotateIfNeeded(bitmap: Bitmap): Bitmap {
    if (imageInfo.rotationDegrees != 0) {
        val matrix = Matrix()
        matrix.postRotate(imageInfo.rotationDegrees.toFloat())
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        bitmap.recycle()
        return rotated
    }
    return bitmap
}

private fun ImageProxy.toNv21(): ByteArray {
    val yPlane = planes[0]
    val uPlane = planes[1]
    val vPlane = planes[2]
    val output = ByteArray(width * height * 3 / 2)

    copyLumaPlane(yPlane, width, height, output)
    interleaveChromaPlanes(
        uPlane = uPlane,
        vPlane = vPlane,
        chromaWidth = width / 2,
        chromaHeight = height / 2,
        output = output,
        outputOffset = width * height
    )

    return output
}

private fun copyLumaPlane(
    plane: ImageProxy.PlaneProxy,
    width: Int,
    height: Int,
    output: ByteArray
) {
    val buffer = plane.buffer.duplicate()
    val row = ByteArray(plane.rowStride)
    var outputOffset = 0

    for (rowIndex in 0 until height) {
        val rowLength = if (plane.pixelStride == 1) {
            width
        } else {
            (width - 1) * plane.pixelStride + 1
        }
        buffer.position(rowIndex * plane.rowStride)
        buffer.get(row, 0, rowLength)
        for (column in 0 until width) {
            output[outputOffset++] = row[column * plane.pixelStride]
        }
    }
}

private fun interleaveChromaPlanes(
    uPlane: ImageProxy.PlaneProxy,
    vPlane: ImageProxy.PlaneProxy,
    chromaWidth: Int,
    chromaHeight: Int,
    output: ByteArray,
    outputOffset: Int
) {
    val uBuffer = uPlane.buffer.duplicate()
    val vBuffer = vPlane.buffer.duplicate()
    val uRow = ByteArray(uPlane.rowStride)
    val vRow = ByteArray(vPlane.rowStride)
    var offset = outputOffset

    for (rowIndex in 0 until chromaHeight) {
        readRow(vBuffer, vPlane.rowStride, rowIndex, rowLength(chromaWidth, vPlane.pixelStride), vRow)
        readRow(uBuffer, uPlane.rowStride, rowIndex, rowLength(chromaWidth, uPlane.pixelStride), uRow)
        for (column in 0 until chromaWidth) {
            output[offset++] = vRow[column * vPlane.pixelStride]
            output[offset++] = uRow[column * uPlane.pixelStride]
        }
    }
}

private fun readRow(
    buffer: ByteBuffer,
    rowStride: Int,
    rowIndex: Int,
    rowLength: Int,
    row: ByteArray
) {
    buffer.position(rowIndex * rowStride)
    buffer.get(row, 0, rowLength)
}

private fun rowLength(width: Int, pixelStride: Int): Int {
    return if (pixelStride == 1) width else (width - 1) * pixelStride + 1
}
