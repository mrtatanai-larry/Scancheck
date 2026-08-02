package com.scan.scancheckerapp

import android.app.Application
import com.scan.scancheckerapp.data.local.ScanDatabase
import com.scan.scancheckerapp.data.preferences.SettingsRepository
import com.scan.scancheckerapp.data.repository.ScanRepository
import com.scan.scancheckerapp.domain.ocr.OcrTextParser
import org.opencv.android.OpenCVLoader

class ScanCheckerApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        OpenCVLoader.initDebug()
    }

    val database: ScanDatabase by lazy {
        ScanDatabase.build(this)
    }

    val settingsRepository: SettingsRepository by lazy {
        SettingsRepository(this)
    }

    val scanRepository: ScanRepository by lazy {
        ScanRepository(
            context = this,
            dao = database.scanRecordDao(),
            settingsRepository = settingsRepository,
            parser = OcrTextParser()
        )
    }
}
