package com.todobom.opennotescanner.scancheck.data.local

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
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE scan_records ADD COLUMN sheetId TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN studentId TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN examId TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN qrRawText TEXT")
                db.execSQL("ALTER TABLE scan_records ADD COLUMN remoteReceivedPaperId INTEGER")
                db.execSQL("DROP INDEX IF EXISTS index_scan_records_normalizedStudentName_normalizedCourse")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_scan_records_imageFileName ON scan_records(imageFileName)")
            }
        }

        fun build(context: Context): ScanDatabase {
            return Room.databaseBuilder(
                context,
                ScanDatabase::class.java,
                "scan_checker.db"
            ).addMigrations(MIGRATION_1_2).build()
        }
    }
}
