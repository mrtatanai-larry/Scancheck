package com.todobom.opennotescanner.scancheck.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.todobom.opennotescanner.OpenNoteScannerApplication

class UploadScanWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {
    override suspend fun doWork(): Result {
        val scanId = inputData.getLong(KEY_SCAN_ID, -1L)
        if (scanId <= 0L) {
            return Result.failure()
        }

        val application = applicationContext as OpenNoteScannerApplication
        return application.scanRepository.uploadRecord(scanId)
    }

    companion object {
        const val KEY_SCAN_ID = "scan_id"
    }
}
