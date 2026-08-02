package com.scan.scancheckerapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.scan.scancheckerapp.ui.theme.ScanCheckerAppTheme
import com.scan.scancheckerapp.ui.ScanCheckerApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ScanCheckerAppTheme {
                ScanCheckerApp()
            }
        }
    }
}
