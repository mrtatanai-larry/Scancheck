package com.scan.scancheckerapp.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [ScanRecord::class],
    version = 2,
    exportSchema = false
)
@TypeConverters(ScanStatusConverter::class)
abstract class ScanDatabase : RoomDatabase() {
    abstract fun scanRecordDao(): ScanRecordDao

    companion object {
        fun build(context: Context): ScanDatabase {
            return Room.databaseBuilder(
                context,
                ScanDatabase::class.java,
                "scan_checker.db"
            )
                .addMigrations(MIGRATION_1_2)
                .build()
        }

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE scan_records ADD COLUMN sheetId TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN studentId TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN examId TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN qrRawText TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN uploadTarget TEXT NOT NULL DEFAULT 'received_papers'")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN needsReviewReason TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN remoteReceivedPaperId INTEGER")
            }
        }
    }
}
