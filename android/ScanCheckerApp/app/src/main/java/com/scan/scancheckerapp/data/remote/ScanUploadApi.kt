package com.scan.scancheckerapp.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST

interface ScanUploadApi {
    @POST("api/received-papers")
    suspend fun uploadScan(@Body request: ScanUploadRequest): Response<ScanUploadResponse>
}
