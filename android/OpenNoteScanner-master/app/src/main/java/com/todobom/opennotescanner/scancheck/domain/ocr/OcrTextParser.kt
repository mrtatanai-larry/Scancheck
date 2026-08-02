package com.todobom.opennotescanner.scancheck.domain.ocr

class OcrTextParser {
    fun parse(rawText: String): ParsedScanText {
        val cleanedText = rawText.trim()
        val lines = cleanedText
            .lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        val studentName = extractField(
            lines = lines,
            labels = listOf("full name", "student name", "name"),
            stopLabels = listOf("course")
        )
        val course = extractField(
            lines = lines,
            labels = listOf("course"),
            stopLabels = listOf("full name", "student name", "name")
        )

        return ParsedScanText(
            studentName = studentName.cleanCandidate(),
            course = course.cleanCandidate(),
            rawText = cleanedText
        )
    }

    private fun extractField(
        lines: List<String>,
        labels: List<String>,
        stopLabels: List<String>
    ): String? {
        lines.forEachIndexed { index, line ->
            val matchedLabel = labels.firstOrNull { matchesLabel(line, it) }
            if (matchedLabel != null) {
                val value = extractInlineValue(line, matchedLabel, stopLabels)
                if (value.isNotBlank() && !looksLikeAnotherLabel(value, labels)) {
                    return value
                }
                val nextLine = lines.drop(index + 1)
                    .firstOrNull { it.isNotBlank() }
                    ?.trim()
                    .orEmpty()
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
        return matchesLabel(value, "name") ||
            matchesLabel(value, "student name") ||
            matchesLabel(value, "full name") ||
            matchesLabel(value, "course")
    }

    private fun String?.cleanCandidate(): String? {
        return this
            ?.substringBefore("DATE", missingDelimiterValue = this)
            ?.substringBefore("ROOM NO", missingDelimiterValue = this)
            ?.substringBefore("SEAT NO", missingDelimiterValue = this)
            ?.replace(Regex("\\s+"), " ")
            ?.trim()
            ?.takeIf { it.isNotBlank() }
    }

    private fun matchesLabel(line: String, label: String): Boolean {
        val normalizedLine = line.normalizeForMatching()
        val normalizedLabel = label.normalizeForMatching()
        if (normalizedLine == normalizedLabel) {
            return true
        }

        return when (normalizedLabel) {
            "fullname" -> normalizedLine.startsWith("fullname") ||
                normalizedLine.startsWith("fullnane") ||
                normalizedLine.startsWith("fullnaine")
            "studentname" -> normalizedLine.startsWith("studentname")
            "name" -> normalizedLine.startsWith("name")
            "course" -> normalizedLine.startsWith("course") ||
                normalizedLine.startsWith("c0urse")
            else -> normalizedLine.startsWith(normalizedLabel)
        }
    }

    private fun extractInlineValue(
        line: String,
        label: String,
        stopLabels: List<String>
    ): String {
        val patterns = when (label.lowercase()) {
            "full name" -> listOf("full\\s*name", "full\\s*nane", "full\\s*naine")
            "student name" -> listOf("student\\s*name")
            "name" -> listOf("name")
            "course" -> listOf("course", "c0urse")
            else -> listOf(Regex.escape(label))
        }

        patterns.forEach { pattern ->
            val regex = Regex("""(?i)^\s*$pattern\s*[:\-]?\s*(.*?)\s*$""")
            val match = regex.matchEntire(line)
            if (match != null) {
                return trimAtNextLabel(
                    value = match.groupValues[1].trim(),
                    stopLabels = stopLabels
                )
            }
        }

        return ""
    }

    private fun trimAtNextLabel(value: String, stopLabels: List<String>): String {
        var endIndex = value.length

        stopLabels.flatMap { stopLabelPatterns(it) }.forEach { pattern ->
            val regex = Regex("""(?i)\b$pattern\s*[:\-]""")
            val match = regex.find(value)
            if (match != null && match.range.first < endIndex) {
                endIndex = match.range.first
            }
        }

        return value.substring(0, endIndex).trim()
    }

    private fun stopLabelPatterns(label: String): List<String> {
        return when (label.lowercase()) {
            "full name" -> listOf("full\\s*name", "full\\s*nane", "full\\s*naine")
            "student name" -> listOf("student\\s*name")
            "name" -> listOf("name")
            "course" -> listOf("course", "c0urse")
            else -> listOf(Regex.escape(label))
        }
    }

    private fun String.normalizeForMatching(): String {
        return lowercase()
            .replace('0', 'o')
            .replace('1', 'i')
            .replace('5', 's')
            .replace(Regex("[^a-z]"), "")
    }
}
