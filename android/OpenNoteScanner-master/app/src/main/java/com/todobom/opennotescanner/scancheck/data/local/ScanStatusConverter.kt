package com.todobom.opennotescanner.scancheck.data.local

import androidx.room.TypeConverter

class ScanStatusConverter {
    @TypeConverter
    fun fromStatus(status: ScanStatus): String = status.name

    @TypeConverter
    fun toStatus(value: String): ScanStatus = ScanStatus.valueOf(value)
}
