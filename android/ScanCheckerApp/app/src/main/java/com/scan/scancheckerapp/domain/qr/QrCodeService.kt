package com.scan.scancheckerapp.domain.qr

import android.content.Context
import android.net.Uri
import com.google.android.gms.tasks.Task
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class QrCodeService(private val context: Context) {
    private val scanner = BarcodeScanning.getClient()

    suspend fun readIdentity(imageFile: File): QrIdentity {
        val image = InputImage.fromFilePath(context, Uri.fromFile(imageFile))
        val rawText = scanner.process(image)
            .await()
            .firstOrNull { !it.rawValue.isNullOrBlank() }
            ?.rawValue
            ?.trim()
        return parse(rawText)
    }

    private fun parse(rawText: String?): QrIdentity {
        if (rawText.isNullOrBlank()) return QrIdentity(null, null, null, null)
        parseJson(rawText)?.let { return it }

        val pairs = mutableMapOf<String, String>()
        rawText
            .split('\n', '&', ';', '|')
            .map { it.trim() }
            .filter { it.contains('=') || it.contains(':') }
            .forEach { part ->
                val delimiter = if (part.contains('=')) '=' else ':'
                val key = part.substringBefore(delimiter).trim().lowercase().replace("-", "_")
                val value = part.substringAfter(delimiter).trim()
                if (key.isNotBlank() && value.isNotBlank()) pairs[key] = value
            }

        val sheetId = firstValue(pairs, "sheet_id", "sheetid", "answer_sheet_id", "answersheetid", "paper_id", "paperid")
        val studentId = firstValue(pairs, "student_id", "studentid")
        val examId = firstValue(pairs, "exam_id", "examid")
        val studentName = firstValue(pairs, "student_name", "studentname", "full_name", "fullname", "name")
        val course = firstValue(pairs, "course", "course_name", "coursename", "program")
        val age = firstValue(pairs, "age")
        val roomNo = firstValue(pairs, "room_no", "roomno", "room")
        val seatNo = firstValue(pairs, "seat_no", "seatno", "seat")
        val entryType = firstValue(pairs, "entry_type", "entrytype")
        val equityGroup = firstValue(pairs, "equity_group", "equitygroup", "special_equity_group", "specialequitygroup")

        return QrIdentity(
            sheetId = sheetId ?: rawText.takeIf { it.length <= 80 && !it.contains(' ') },
            studentId = studentId,
            examId = examId,
            rawText = rawText,
            studentName = studentName,
            course = course,
            age = age,
            roomNo = roomNo,
            seatNo = seatNo,
            entryType = entryType,
            equityGroup = equityGroup
        )
    }

    private fun parseJson(rawText: String): QrIdentity? {
        return try {
            val json = JSONObject(rawText)
            QrIdentity(
                sheetId = json.optStringAny("sheet_id", "sheetId", "answer_sheet_id", "answerSheetId", "paper_id", "paperId"),
                studentId = json.optStringAny("student_id", "studentId"),
                examId = json.optStringAny("exam_id", "examId"),
                rawText = rawText,
                studentName = json.optStringAny("student_name", "studentName", "full_name", "fullName", "name"),
                course = json.optStringAny("course", "course_name", "courseName", "program"),
                age = json.optStringAny("age"),
                roomNo = json.optStringAny("room_no", "roomNo", "room"),
                seatNo = json.optStringAny("seat_no", "seatNo", "seat"),
                entryType = json.optStringAny("entry_type", "entryType"),
                equityGroup = json.optStringAny("equity_group", "equityGroup", "special_equity_group", "specialEquityGroup")
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun JSONObject.optStringAny(vararg names: String): String? {
        for (name in names) {
            val value = optString(name, "").trim()
            if (value.isNotBlank()) return value
        }
        return null
    }

    private fun firstValue(values: Map<String, String>, vararg names: String): String? {
        for (name in names) {
            values[name]?.takeIf { it.isNotBlank() }?.let { return it }
        }
        return null
    }

    private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
        addOnSuccessListener { result -> continuation.resume(result) }
        addOnFailureListener { exception -> continuation.resumeWithException(exception) }
    }
}
