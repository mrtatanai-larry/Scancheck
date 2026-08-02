package com.todobom.opennotescanner.scancheck.data.repository

import java.io.File
import java.util.Locale

object ScanFileManager {
    fun normalizeForDuplicateKey(value: String?): String? {
        return value
            ?.trim()
            ?.lowercase(Locale.US)
            ?.replace(Regex("\\s+"), " ")
            ?.takeIf { it.isNotBlank() }
    }

    fun deleteStoredFile(path: String) {
        File(path).delete()
    }
}
