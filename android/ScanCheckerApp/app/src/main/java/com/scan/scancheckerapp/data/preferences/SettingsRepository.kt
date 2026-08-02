package com.scan.scancheckerapp.data.preferences

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

class SettingsRepository(context: Context) {
    private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val _apiBaseUrl = MutableStateFlow(
        normalizeBaseUrl(preferences.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL).orEmpty())
    )

    val apiBaseUrl: StateFlow<String> = _apiBaseUrl.asStateFlow()

    fun currentApiBaseUrl(): String = _apiBaseUrl.value

    suspend fun updateApiBaseUrl(value: String) {
        val normalized = normalizeBaseUrl(value)
        preferences.edit().putString(KEY_API_BASE_URL, normalized).apply()
        _apiBaseUrl.value = normalized
    }

    fun isValidBaseUrl(value: String = _apiBaseUrl.value): Boolean {
        return value.toHttpUrlOrNull() != null
    }

    companion object {
        private const val PREFS_NAME = "scan_checker_settings"
        private const val KEY_API_BASE_URL = "api_base_url"
        const val DEFAULT_API_BASE_URL = "http://10.0.2.2:3000/"

        fun normalizeBaseUrl(rawValue: String): String {
            val trimmed = rawValue.trim()
            if (trimmed.isBlank()) {
                return DEFAULT_API_BASE_URL
            }
            return if (trimmed.endsWith("/")) trimmed else "$trimmed/"
        }
    }
}
