package com.scan.scancheckerapp.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ScanRecordDao {
    @Query("SELECT * FROM scan_records ORDER BY capturedAt DESC")
    fun observeAll(): Flow<List<ScanRecord>>

    @Query("SELECT * FROM scan_records WHERE id = :id LIMIT 1")
    suspend fun getById(id: Long): ScanRecord?

    @Query("SELECT * FROM scan_records WHERE status IN (:statuses) ORDER BY capturedAt DESC")
    suspend fun getByStatuses(statuses: List<String>): List<ScanRecord>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(record: ScanRecord): Long

    @Update
    suspend fun update(record: ScanRecord)

    @Query("DELETE FROM scan_records WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query(
        """
        SELECT COUNT(*) FROM scan_records
        WHERE normalizedStudentName = :normalizedStudentName
        AND normalizedCourse = :normalizedCourse
        AND (:excludeId IS NULL OR id != :excludeId)
        """
    )
    suspend fun countDuplicates(
        normalizedStudentName: String,
        normalizedCourse: String,
        excludeId: Long?
    ): Int
}
