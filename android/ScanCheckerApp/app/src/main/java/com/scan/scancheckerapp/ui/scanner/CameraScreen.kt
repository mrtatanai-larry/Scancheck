package com.scan.scancheckerapp.ui.scanner

import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.scan.scancheckerapp.domain.scanner.QRScannerAnalyzer
import java.io.File
import java.util.concurrent.Executors

@Composable
fun CameraScreen(
    uploadState: UploadState,
    onQrDetected: (String, String) -> Unit,
    onCaptureClick: (ImageCapture) -> Unit,
    onManualExamIdEntry: (String) -> Unit,
    onReset: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    
    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        )
    }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
        onResult = { granted -> hasCameraPermission = granted }
    )

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) {
            launcher.launch(Manifest.permission.CAMERA)
        }
    }

    if (!hasCameraPermission) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Camera permission required")
        }
        return
    }

    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.PERFORMANCE
            scaleType = PreviewView.ScaleType.FIT_CENTER
        }
    }
    val imageCapture = remember { 
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setJpegQuality(95)
            .build()
    }
    val imageAnalysis = remember {
        ImageAnalysis.Builder()
            .setTargetAspectRatio(AspectRatio.RATIO_4_3)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
    }

    LaunchedEffect(previewView) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }

            imageAnalysis.setAnalyzer(cameraExecutor, QRScannerAnalyzer { examId, qrData ->
                onQrDetected(examId, qrData)
            })

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageCapture,
                    imageAnalysis
                )
                Log.d("CameraX", "Camera bound successfully (CameraScreen)")
            } catch (e: Exception) {
                Log.e("CameraX", "Failed to bind camera (CameraScreen)", e)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

        // UI Overlays
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Status Header
            StatusHeader(uploadState)

            // Bottom Controls
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                if (uploadState is UploadState.ReadyToCapture) {
                    Button(
                        onClick = { onCaptureClick(imageCapture) },
                        modifier = Modifier.size(80.dp),
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(containerColor = Color.White)
                    ) {
                        // Capture icon or just empty
                    }
                    Text(
                        "Tap to Capture",
                        color = Color.White,
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.bodyLarge
                    )
                }

                if (uploadState is UploadState.Error || uploadState is UploadState.Success) {
                    Button(onClick = onReset) {
                        Text(if (uploadState is UploadState.Success) "Scan Next" else "Try Again")
                    }
                }
                
                if (uploadState == UploadState.ScanningQR) {
                   ManualEntryFallback(onManualExamIdEntry)
                }
            }
        }
    }
}

@Composable
fun StatusHeader(state: UploadState) {
    val (text, color) = when (state) {
        UploadState.Idle -> "Initializing..." to Color.Gray
        UploadState.ScanningQR -> "Point at QR Code" to Color.White
        is UploadState.ReadyToCapture -> "QR Detected: ${state.examId}" to Color.Green
        UploadState.Uploading -> "Uploading Image..." to Color.Yellow
        UploadState.Success -> "Upload Successful!" to Color.Green
        is UploadState.Error -> "Error: ${state.message}" to Color.Red
    }

    Surface(
        color = Color.Black.copy(alpha = 0.6f),
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.padding(top = 16.dp)
    ) {
        Text(
            text = text,
            color = color,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center
        )
    }
}

@Composable
fun ManualEntryFallback(onManualExamIdEntry: (String) -> Unit) {
    var showDialog by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }

    if (showDialog) {
        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text("Manual Exam ID") },
            text = {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("Exam ID") }
                )
            },
            confirmButton = {
                TextButton(onClick = { 
                    if (text.isNotBlank()) {
                        onManualExamIdEntry(text)
                        showDialog = false
                    }
                }) {
                    Text("OK")
                }
            },
            dismissButton = {
                TextButton(onClick = { showDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }

    TextButton(onClick = { showDialog = true }) {
        Text("Manual ID Fallback", color = Color.White.copy(alpha = 0.7f))
    }
}
