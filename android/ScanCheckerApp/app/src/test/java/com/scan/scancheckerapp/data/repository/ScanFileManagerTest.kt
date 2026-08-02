package com.scan.scancheckerapp.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanFileManagerTest {
    @Test
    fun `buildFinalFileName normalizes text and keeps timestamp`() {
        val fileName = ScanFileManager.buildFinalFileName(
            studentName = "John   Doe",
            course = "BSIT 1-A",
            capturedAt = 1_745_744_123_000
        )

        assertTrue(fileName.startsWith("john_doe_bsit_1_a_"))
        assertTrue(fileName.endsWith(".jpg"))
    }

    @Test
    fun `normalizeForDuplicateKey trims and compresses spaces`() {
        assertEquals(
            "mary ann",
            ScanFileManager.normalizeForDuplicateKey("  Mary   Ann  ")
        )
    }

    @Test
    fun `normalizeForDuplicateKey returns null for blank input`() {
        assertNull(ScanFileManager.normalizeForDuplicateKey("   "))
    }
}
