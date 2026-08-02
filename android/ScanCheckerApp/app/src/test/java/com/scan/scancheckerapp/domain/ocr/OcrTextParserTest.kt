package com.scan.scancheckerapp.domain.ocr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OcrTextParserTest {
    private val parser = OcrTextParser()

    @Test
    fun `extracts student name and course from same line labels`() {
        val parsed = parser.parse(
            """
            Name: Jane Cruz
            Course: BSIT 3A
            """.trimIndent()
        )

        assertEquals("Jane Cruz", parsed.studentName)
        assertEquals("BSIT 3A", parsed.course)
    }

    @Test
    fun `extracts values from next line when labels are alone`() {
        val parsed = parser.parse(
            """
            Student Name
            Mark Santos
            Course
            BSCpE 2B
            """.trimIndent()
        )

        assertEquals("Mark Santos", parsed.studentName)
        assertEquals("BSCpE 2B", parsed.course)
    }

    @Test
    fun `returns partial result when course is missing`() {
        val parsed = parser.parse(
            """
            Name: Carla Ramos
            Score: 45
            """.trimIndent()
        )

        assertEquals("Carla Ramos", parsed.studentName)
        assertNull(parsed.course)
    }

    @Test
    fun `returns no fields for unrelated OCR text`() {
        val parsed = parser.parse(
            """
            Mathematics Quiz
            Answer all items
            """.trimIndent()
        )

        assertNull(parsed.studentName)
        assertNull(parsed.course)
    }
}
