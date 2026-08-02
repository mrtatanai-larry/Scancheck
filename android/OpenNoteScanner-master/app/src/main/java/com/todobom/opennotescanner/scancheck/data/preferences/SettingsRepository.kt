package com.todobom.opennotescanner.scancheck.data.preferences

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

class SettingsRepository(context: Context) {
    private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val _apiBaseUrl = MutableStateFlow(resolveInitialBaseUrl())

    val apiBaseUrl: StateFlow<String> = _apiBaseUrl.asStateFlow()

    fun currentApiBaseUrl(): String = _apiBaseUrl.value

    suspend fun updateApiBaseUrl(value: String) {
        val normalized = normalizeBaseUrl(value)
        preferences.edit().putString(KEY_API_BASE_URL, normalized).apply()
        _apiBaseUrl.value = normalized
    }

    fun isValidBaseUrl(value: String = _apiBaseUrl.value): Boolean {
        val url = value.toHttpUrlOrNull() ?: return false
        return url.scheme in setOf("http", "https") && url.host.isNotBlank()
    }

    private fun resolveInitialBaseUrl(): String {
        val normalized = normalizeBaseUrl(preferences.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL).orEmpty())
        val resolved = if (normalized == LEGACY_DEFAULT_API_BASE_URL) DEFAULT_API_BASE_URL else normalized
        if (resolved != normalized) {
            preferences.edit().putString(KEY_API_BASE_URL, resolved).apply()
        }
        return resolved
    }

    companion object {
        private const val PREFS_NAME = "scan_checker_settings"
        private const val KEY_API_BASE_URL = "api_base_url"
        private const val LEGACY_DEFAULT_API_BASE_URL = "http://192.168.137.1:3002/"
        const val DEFAULT_API_BASE_URL = "http://192.168.137.1:3000/"

        fun normalizeBaseUrl(rawValue: String): String {
            val trimmed = rawValue.trim()
            if (trimmed.isBlank()) {
                return DEFAULT_API_BASE_URL
            }
            val withScheme = if ("://" in trimmed) trimmed else "http://$trimmed"
            return if (withScheme.endsWith("/")) withScheme else "$withScheme/"
        }
    }
}
