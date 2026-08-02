package com.todobom.opennotescanner.scancheck.data.local

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

    @Query("SELECT * FROM scan_records WHERE status IN (:statuses) ORDER BY capturedAt ASC")
    suspend fun getByStatuses(statuses: List<String>): List<ScanRecord>

    @Query("SELECT COUNT(*) FROM scan_records WHERE imageFileName = :imageFileName AND (:excludeId IS NULL OR id != :excludeId)")
    suspend fun countByImageFileName(imageFileName: String, excludeId: Long?): Int

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

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(record: ScanRecord): Long

    @Update
    suspend fun update(record: ScanRecord)

    @Query("DELETE FROM scan_records WHERE id = :id")
    suspend fun deleteById(id: Long)
}
