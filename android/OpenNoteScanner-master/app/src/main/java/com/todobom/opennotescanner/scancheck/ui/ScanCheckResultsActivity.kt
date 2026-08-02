package com.todobom.opennotescanner.scancheck.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent

class ScanCheckResultsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ScanCheckTheme {
                ScanCheckResultsScreen()
            }
        }
    }
}
