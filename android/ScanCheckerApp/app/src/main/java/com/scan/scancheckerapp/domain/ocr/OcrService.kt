package com.scan.scancheckerapp.domain.ocr

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import androidx.core.net.toUri

class OcrService(
    private val context: Context,
    private val parser: OcrTextParser
) {
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    suspend fun recognize(file: File): ParsedScanText {
        val image = InputImage.fromFilePath(context, file.toUri())
        val result = recognizer.process(image).await()
        return parser.parse(result.text)
    }

    private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
        addOnSuccessListener { result ->
            continuation.resume(result)
        }.addOnFailureListener { exception ->
            continuation.resumeWithException(exception)
        }
    }
}
