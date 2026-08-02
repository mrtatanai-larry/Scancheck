package com.scan.scancheckerapp.domain.ocr

class OcrTextParser {
    fun parse(rawText: String): ParsedScanText {
        val cleanedText = rawText.trim()
        val lines = cleanedText
            .lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val studentName = extractField(lines, listOf("student name", "name"))
        val course = extractField(lines, listOf("course"))

        return ParsedScanText(
            studentName = studentName.cleanCandidate(),
            course = course.cleanCandidate(),
            rawText = cleanedText
        )
    }

    private fun extractField(lines: List<String>, labels: List<String>): String? {
        val labelPattern = labels.joinToString("|") { Regex.escape(it) }
        val sameLineRegex = Regex(
            pattern = """(?i)^\s*(?:$labelPattern)\s*[:\-]?\s*(.+?)\s*$"""
        )

        lines.forEachIndexed { index, line ->
            val match = sameLineRegex.matchEntire(line)
            if (match != null) {
                val value = match.groupValues[1].trim()
                if (value.isNotBlank() && !looksLikeAnotherLabel(value, labels)) {
                    return value
                }
                val nextLine = lines.getOrNull(index + 1)?.trim().orEmpty()
                if (nextLine.isNotBlank() && !looksLikeKnownLabel(nextLine)) {
                    return nextLine
                }
            }
        }

        return null
    }

    private fun looksLikeAnotherLabel(value: String, labels: List<String>): Boolean {
        return labels.any { value.equals(it, ignoreCase = true) }
    }

    private fun looksLikeKnownLabel(value: String): Boolean {
        val lowered = value.lowercase()
        return lowered == "name" || lowered == "student name" || lowered == "course"
    }

    private fun String?.cleanCandidate(): String? {
        return this
            ?.replace(Regex("\\s+"), " ")
            ?.trim()
            ?.takeIf { it.isNotBlank() }
    }
}
