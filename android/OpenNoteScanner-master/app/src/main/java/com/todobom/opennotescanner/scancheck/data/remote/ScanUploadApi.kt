package com.todobom.opennotescanner.scancheck.data.remote

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface ScanUploadApi {
    @GET("api/health")
    suspend fun healthCheck(): Response<Unit>

    @POST("api/received-papers")
    suspend fun uploadScan(
        @Body request: ScanUploadRequest
    ): Response<ScanUploadResponse>
}
