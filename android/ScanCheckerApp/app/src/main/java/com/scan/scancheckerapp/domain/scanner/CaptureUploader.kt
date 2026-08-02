package com.scan.scancheckerapp.domain.scanner

import android.content.Context
import com.scan.scancheckerapp.data.remote.ScanUploadApi
import com.scan.scancheckerapp.data.remote.ScanUploadRequest
import com.scan.scancheckerapp.data.remote.ScanUploadResponse
import com.scan.scancheckerapp.data.remote.ScanUploadServiceFactory

class CaptureUploader(private val context: Context, private val baseUrl: String) {

    private val api: ScanUploadApi by lazy {
        ScanUploadServiceFactory.create(baseUrl)
    }

    suspend fun upload(request: ScanUploadRequest): Result<ScanUploadResponse> {
        return try {
            val response = api.uploadScan(request)

            if (response.isSuccessful) {
                val body = response.body()
                if (body != null && body.success) {
                    Result.success(body)
                } else {
                    Result.failure(Exception(body?.message ?: "Unknown error from server"))
                }
            } else {
                Result.failure(Exception("HTTP Error: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
