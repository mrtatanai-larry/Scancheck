package com.scan.scancheckerapp.data.remote

import com.scan.scancheckerapp.data.preferences.SettingsRepository
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ScanUploadServiceFactory {
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(60, TimeUnit.SECONDS)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    fun create(baseUrl: String): ScanUploadApi {
        return Retrofit.Builder()
            .baseUrl(SettingsRepository.normalizeBaseUrl(baseUrl))
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ScanUploadApi::class.java)
    }
}
