@file:OptIn(ExperimentalMaterial3Api::class)
package com.scan.scancheckerapp.ui

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.camera.core.AspectRatio
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.scan.scancheckerapp.R
import com.scan.scancheckerapp.data.local.ScanRecord
import com.scan.scancheckerapp.data.repository.ScanFileManager
import com.scan.scancheckerapp.domain.scanner.DocumentCornerDetector
import com.scan.scancheckerapp.ui.scanner.toBitmap
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min
import android.util.Log
import org.opencv.core.Point
import com.scan.scancheckerapp.domain.scanner.DocumentDetectionInfo

@Composable
fun ScanCheckerApp() {
    val context = LocalContext.current
    val viewModel: AppViewModel = viewModel(
        factory = AppViewModelFactory(context.applicationContext as android.app.Application)
    )
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        viewModel.messages.collect { message ->
            snackbarHostState.showSnackbar(message)
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = if (uiState.selectedScreen == AppScreen.SCAN) {
            {}
        } else {
            {
                AppBottomBar(
                    selectedScreen = uiState.selectedScreen,
                    onScreenSelected = viewModel::selectScreen
                )
            }
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .background(MaterialTheme.colorScheme.background)
        ) {
            when (uiState.selectedScreen) {
                AppScreen.SCAN -> ScanScreen(
                    serverConnectionStatus = uiState.serverConnectionStatus,
                    retakeAttempts = uiState.retakeAttempts,
                    isProcessingCapture = uiState.isProcessingCapture,
                    onImageCaptured = viewModel::handleCapturedImage,
                    onCaptureError = viewModel::reportCameraError,
                    onOpenResults = { viewModel.selectScreen(AppScreen.RESULTS) }
                )
                AppScreen.RESULTS -> ResultsScreen(
                    uiState = uiState,
                    onSearchQueryChange = viewModel::updateSearchQuery,
                    onToggleFilters = viewModel::toggleFilters,
                    onPreviewRecord = viewModel::openPreview,
                    onDeleteRecord = viewModel::requestDelete,
                    onUploadPending = viewModel::uploadPendingRecords
                )
                AppScreen.SETTINGS -> SettingsScreen(
                    apiBaseUrl = uiState.apiBaseUrl,
                    serverConnectionStatus = uiState.serverConnectionStatus,
                    onTestConnection = viewModel::testServerConnection,
                    onSave = viewModel::saveApiBaseUrl
                )
            }
        }
    }

    if (uiState.showFilters) {
        FilterBottomSheet(
            availableCourses = uiState.availableCourses,
            selectedCourse = uiState.selectedCourse,
            sortOrder = uiState.sortOrder,
            onCourseSelected = viewModel::selectCourseFilter,
            onSortOrderSelected = viewModel::selectSortOrder,
            onDismiss = viewModel::toggleFilters
        )
    }

    uiState.previewRecord?.let { record ->
        PreviewDialog(
            record = record,
            onDismiss = viewModel::dismissPreview,
            onEdit = {
                viewModel.dismissPreview()
                viewModel.openEditor(record)
            }
        )
    }

    uiState.editingRecord?.let { record ->
        EditRecordDialog(
            record = record,
            onDismiss = viewModel::dismissEditor,
            onSave = viewModel::saveEditedRecord
        )
    }

    uiState.deleteCandidate?.let { record ->
        DeleteRecordDialog(
            record = record,
            onDismiss = viewModel::dismissDelete,
            onConfirm = viewModel::confirmDelete
        )
    }
}

@Composable
private fun AppBottomBar(
    selectedScreen: AppScreen,
    onScreenSelected: (AppScreen) -> Unit
) {
    Surface(
        color = Color.Transparent,
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 8.dp, vertical = 12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircleNavButton(
                selected = selectedScreen == AppScreen.SCAN,
                iconRes = R.drawable.photo_camera_24px,
                onClick = { onScreenSelected(AppScreen.SCAN) }
            )
            Spacer(modifier = Modifier.width(16.dp))
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.92f),
                shape = RoundedCornerShape(34.dp),
                tonalElevation = 4.dp,
                modifier = Modifier.height(66.dp)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    DestinationNavButton(
                        label = "Captured",
                        selected = selectedScreen == AppScreen.RESULTS,
                        iconRes = R.drawable.database_24px,
                        onClick = { onScreenSelected(AppScreen.RESULTS) }
                    )
                    DestinationNavButton(
                        label = "Settings",
                        selected = selectedScreen == AppScreen.SETTINGS,
                        iconRes = R.drawable.settings_24px,
                        onClick = { onScreenSelected(AppScreen.SETTINGS) }
                    )
                }
            }
        }
    }
}

@Composable
private fun DestinationNavButton(
    label: String,
    selected: Boolean,
    iconRes: Int,
    onClick: () -> Unit
) {
    Surface(
        color = if (selected) MaterialTheme.colorScheme.surface else Color.Transparent,
        shape = RoundedCornerShape(24.dp),
        tonalElevation = if (selected) 2.dp else 0.dp,
        modifier = Modifier
            .height(48.dp)
            .animateContentSize()
            .clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(
                horizontal = if (selected) 14.dp else 12.dp,
                vertical = 12.dp
            ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(if (selected) 8.dp else 0.dp)
        ) {
            if (selected) {
                Text(
                    text = label,
                    color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1
                )
            }
            Icon(
                painter = painterResource(iconRes),
                contentDescription = label,
                tint = if (selected) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.size(if (selected) 18.dp else 22.dp)
            )
        }
    }
}

@Composable
private fun CircleNavButton(
    selected: Boolean,
    iconRes: Int,
    onClick: () -> Unit,
    compact: Boolean = false
) {
    val size = if (compact) 48.dp else 72.dp
    Surface(
        color = if (selected) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.secondaryContainer
        },
        shape = CircleShape,
        tonalElevation = if (selected) 4.dp else 1.dp,
        modifier = Modifier
            .size(size)
            .clickable(onClick = onClick)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                painter = painterResource(iconRes),
                contentDescription = null,
                tint = if (selected) {
                    MaterialTheme.colorScheme.onPrimary
                } else {
                    MaterialTheme.colorScheme.onSecondaryContainer
                },
                modifier = Modifier.size(if (compact) 18.dp else 24.dp)
            )
        }
    }
}

@Composable
private fun ScanScreen(
    serverConnectionStatus: ServerConnectionStatus,
    retakeAttempts: Int,
    isProcessingCapture: Boolean,
    onImageCaptured: (File) -> Unit,
    onCaptureError: (String) -> Unit,
    onOpenResults: () -> Unit
) {
    val context = LocalContext.current
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torchEnabled by remember { mutableStateOf(false) }
    var detectedDocument by remember { mutableStateOf<DocumentOverlay?>(null) }
    var documentInfo by remember { mutableStateOf<DocumentDetectionInfo?>(null) }
    var cameraPermissionGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        cameraPermissionGranted = granted
    }

    LaunchedEffect(cameraPermissionGranted) {
        if (!cameraPermissionGranted) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        ConnectionStatusChip(
            status = serverConnectionStatus,
            modifier = Modifier.align(Alignment.Start)
        )

        if (!cameraPermissionGranted) {
            Surface(
                color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(18.dp),
                tonalElevation = 2.dp,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text(
                        text = "Camera permission is required to scan test papers.",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                        Text("Allow Camera")
                    }
                }
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = "Show the full answer sheet. Keep all 4 corner squares visible. Background/table is okay. Do not crop the paper edges.",
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.78f),
                    textAlign = TextAlign.Center
                )

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .background(Color.Black.copy(alpha = 0.05f))
                ) {
                    CameraPreview(
                        onImageCaptureReady = { imageCapture = it },
                        onCameraReady = { boundCamera ->
                            camera = boundCamera
                        },
                        onDocumentDetected = { corners, imageWidth, imageHeight ->
                            detectedDocument = if (corners != null && imageWidth > 0 && imageHeight > 0) {
                                DocumentOverlay(corners, imageWidth, imageHeight)
                            } else {
                                null
                            }
                        },
                        onDocumentInfo = { info ->
                            documentInfo = info
                        },
                        modifier = Modifier.fillMaxSize()
                    )

                    DocumentGuideOverlay(detectedDocument)

                    if (isProcessingCapture) {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .background(Color.Black.copy(alpha = 0.28f)),
                            contentAlignment = Alignment.Center
                        ) {
                            Surface(
                                color = MaterialTheme.colorScheme.surface,
                                shape = RoundedCornerShape(20.dp)
                            ) {
                                Text(
                                    text = "Preparing paper for upload...",
                                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 12.dp),
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            SmallActionCircle(
                iconRes = R.drawable.flash_24px,
                selected = torchEnabled,
                onClick = {
                    val nextValue = !torchEnabled
                    camera?.cameraControl?.enableTorch(nextValue)
                    torchEnabled = nextValue
                }
            )

            Spacer(modifier = Modifier.width(44.dp))

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Surface(
                    onClick = {
                        val capture = imageCapture
                        if (capture == null || isProcessingCapture) {
                            onCaptureError("Camera is not ready yet.")
                            return@Surface
                        }

                        val greenVisible = documentInfo?.isAcceptable == true && documentInfo?.corners?.size == 4
                        Log.d("Capture", "captureSource=android_image_capture greenOutlineVisible=$greenVisible captureBlocked=false")

                        val tempFile = ScanFileManager.createTempCaptureFile(context)
                        capture.takePicture(
                            ImageCapture.OutputFileOptions.Builder(tempFile).build(),
                            ContextCompat.getMainExecutor(context),
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                                    onImageCaptured(tempFile)
                                }

                                override fun onError(exception: ImageCaptureException) {
                                    tempFile.delete()
                                    onCaptureError(exception.message ?: "Capture failed.")
                                }
                            }
                        )
                    },
                    color = MaterialTheme.colorScheme.primary,
                    shape = CircleShape,
                    tonalElevation = 4.dp,
                    modifier = Modifier.size(80.dp)
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            painter = painterResource(R.drawable.photo_camera_24px),
                            contentDescription = "Capture",
                            tint = MaterialTheme.colorScheme.onPrimary,
                            modifier = Modifier.size(28.dp)
                        )
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                val buttonLabel = if (documentInfo?.isAcceptable == true && documentInfo?.corners?.size == 4) "Scan" else "Capture Anyway"
                Text(
                    text = buttonLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.8f)
                )
            }

            Spacer(modifier = Modifier.width(44.dp))

            SmallActionCircle(
                iconRes = R.drawable.keyboard_arrow_right_24px,
                onClick = onOpenResults
            )
        }
    }
}

private data class DocumentOverlay(
    val corners: List<Point>,
    val imageWidth: Int,
    val imageHeight: Int
)

@Composable
private fun DocumentGuideOverlay(document: DocumentOverlay?) {
    Box(modifier = Modifier.fillMaxSize()) {
        if (document == null || document.corners.size != 4) {
            Box(
                modifier = Modifier
                    .align(Alignment.Center)
                    .fillMaxWidth(0.85f)
                    .aspectRatio(0.654f)
                    .border(
                        width = 3.dp,
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.82f),
                        shape = RoundedCornerShape(32.dp)
                    )
            )
            return@Box
        }

        Canvas(modifier = Modifier.fillMaxSize()) {
            val scale = max(
                size.width / document.imageWidth.toFloat(),
                size.height / document.imageHeight.toFloat()
            )
            val offsetX = (size.width - document.imageWidth * scale) / 2f
            val offsetY = (size.height - document.imageHeight * scale) / 2f
            fun mapped(point: Point): Offset {
                return Offset(
                    x = offsetX + point.x.toFloat() * scale,
                    y = offsetY + point.y.toFloat() * scale
                )
            }

            val path = Path()
            val first = mapped(document.corners[0])
            path.moveTo(first.x, first.y)
            document.corners.drop(1).forEach { corner ->
                val next = mapped(corner)
                path.lineTo(next.x, next.y)
            }
            path.close()

            drawPath(
                path = path,
                color = Color(0xFF23D46B),
                style = Stroke(width = 5.dp.toPx())
            )
            document.corners.forEach { corner ->
                drawCircle(
                    color = Color(0xFF23D46B),
                    radius = 6.dp.toPx(),
                    center = mapped(corner),
                    style = Fill
                )
            }
        }
    }
}

@Composable
private fun SmallActionCircle(
    iconRes: Int,
    selected: Boolean = false,
    onClick: () -> Unit
) {
    Surface(
        onClick = onClick,
        color = if (selected) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.secondaryContainer
        },
        shape = CircleShape,
        tonalElevation = if (selected) 4.dp else 1.dp,
        modifier = Modifier.size(52.dp)
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                painter = painterResource(iconRes),
                contentDescription = null,
                tint = if (selected) {
                    MaterialTheme.colorScheme.onPrimary
                } else {
                    MaterialTheme.colorScheme.onSecondaryContainer
                },
                modifier = Modifier.size(22.dp)
            )
        }
    }
}


@Composable
private fun ConnectionStatusChip(
    status: ServerConnectionStatus,
    modifier: Modifier = Modifier
) {
    val text = when (status) {
        ServerConnectionStatus.CHECKING -> "Checking server..."
        ServerConnectionStatus.CONNECTED -> "Connected to server"
        ServerConnectionStatus.DISCONNECTED -> "Not connected to server"
    }
    SoftStatusChip(
        text = text,
        modifier = modifier
    )
}

@Composable
private fun CameraPreview(
    onImageCaptureReady: (ImageCapture) -> Unit,
    onCameraReady: (Camera) -> Unit,
    onDocumentDetected: (List<Point>?, Int, Int) -> Unit,
    onDocumentInfo: (DocumentDetectionInfo?) -> Unit = {},
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.PERFORMANCE
            scaleType = PreviewView.ScaleType.FIT_CENTER
        }
    }
    val imageCapture = remember {
        ImageCapture.Builder()
            .setTargetAspectRatio(AspectRatio.RATIO_4_3)
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setJpegQuality(95)
            .build()
    }
    val currentOnImageCaptureReady by rememberUpdatedState(onImageCaptureReady)
    val currentOnDocumentDetected by rememberUpdatedState(onDocumentDetected)
    val currentOnDocumentInfo by rememberUpdatedState(onDocumentInfo)

    DisposableEffect(lifecycleOwner, previewView) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        val executor = ContextCompat.getMainExecutor(context)
        val analysisExecutor = Executors.newSingleThreadExecutor()
        val listener = Runnable {
            val cameraProvider = cameraProviderFuture.get()
            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val imageAnalysis = ImageAnalysis.Builder()
                .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            var lastAnalysisAt = 0L
            imageAnalysis.setAnalyzer(analysisExecutor) { imageProxy ->
                val now = System.currentTimeMillis()
                if (now - lastAnalysisAt < 250L) {
                    imageProxy.close()
                    return@setAnalyzer
                }
                lastAnalysisAt = now

                try {
                    val bitmap = imageProxy.toBitmap()
                    if (bitmap == null) {
                        executor.execute { currentOnDocumentDetected(null, imageProxy.width, imageProxy.height) }
                        return@setAnalyzer
                    }
                    val detectionInfo = DocumentCornerDetector.detectWithInfo(bitmap, requireHotArea = true)
                    val corners = detectionInfo.corners
                    val imageWidth = bitmap.width
                    val imageHeight = bitmap.height
                    bitmap.recycle()
                    val cornersStr = if (detectionInfo.corners?.size == 4) {
                        "TL=${detectionInfo.corners[0]} TR=${detectionInfo.corners[1]} BR=${detectionInfo.corners[2]} BL=${detectionInfo.corners[3]}"
                    } else {
                        "no_corners"
                    }
                    Log.d("DocDetect", "conf=${detectionInfo.confidence} blur=${detectionInfo.blurScore} bright=${detectionInfo.brightness} tilt=${detectionInfo.tiltDegrees} $cornersStr acceptable=${detectionInfo.isAcceptable}")
                    executor.execute {
                        currentOnDocumentDetected(corners, imageWidth, imageHeight)
                        currentOnDocumentInfo(detectionInfo)
                    }
                } finally {
                    imageProxy.close()
                }
            }
            try {
                cameraProvider.unbindAll()
                val boundCamera = cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageCapture,
                    imageAnalysis
                )
                onCameraReady(boundCamera)
                currentOnImageCaptureReady(imageCapture)

                // Tap-to-focus
                val cameraControl = boundCamera.cameraControl
                val meteringPointFactory = previewView.meteringPointFactory
                previewView.setOnTouchListener { _, event ->
                    when (event.action) {
                        android.view.MotionEvent.ACTION_DOWN -> {
                            val point = meteringPointFactory.createPoint(event.x, event.y)
                            val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF).build()
                            cameraControl.startFocusAndMetering(action)
                            true
                        }
                        else -> false
                    }
                }

                Log.d("CameraX", "Camera bound successfully")
            } catch (e: Exception) {
                Log.e("CameraX", "Failed to bind camera", e)
            }
        }
        cameraProviderFuture.addListener(listener, executor)
        onDispose {
            analysisExecutor.shutdown()
            if (cameraProviderFuture.isDone) {
                cameraProviderFuture.get().unbindAll()
            }
        }
    }

    androidx.compose.ui.viewinterop.AndroidView(
        factory = { previewView },
        modifier = modifier
    )
}

@Composable
private fun ResultsScreen(
    uiState: ScanAppUiState,
    onSearchQueryChange: (String) -> Unit,
    onToggleFilters: () -> Unit,
    onPreviewRecord: (ScanRecord) -> Unit,
    onDeleteRecord: (ScanRecord) -> Unit,
    onUploadPending: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Text(
            text = "Scan Results",
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            SearchPill(
                query = uiState.searchQuery,
                onQueryChange = onSearchQueryChange,
                modifier = Modifier.weight(1f)
            )
            Surface(
                color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(22.dp),
                tonalElevation = 1.dp,
                modifier = Modifier
                    .height(44.dp)
                    .clickable(onClick = onUploadPending)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp)
                ) {
                    Text(
                        text = "Upload",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Icon(
                        painter = painterResource(R.drawable.database_upload_24px),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(16.dp)
                    )
                }
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            SoftStatusChip(
                text = "Display Student Course",
                iconRes = R.drawable.school_24px
            )
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                shape = CircleShape,
                tonalElevation = 1.dp,
                modifier = Modifier
                    .size(44.dp)
                    .clickable(onClick = onToggleFilters)
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        painter = painterResource(R.drawable.sort_24px),
                        contentDescription = "Filter scans",
                        tint = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.size(18.dp)
                    )
                }
            }
        }

        if (uiState.records.isEmpty()) {
            Surface(
                color = MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(22.dp),
                tonalElevation = 1.dp,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = "No scans yet. Capture a paper first and it will appear here.",
                    modifier = Modifier.padding(18.dp),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f)
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 112.dp)
            ) {
                items(uiState.records, key = { it.id }) { record ->
                    ScanRecordRow(
                        record = record,
                        onPreview = { onPreviewRecord(record) },
                        onDelete = { onDeleteRecord(record) }
                    )
                }
            }
        }
    }
}

@Composable
private fun SearchPill(
    query: String,
    onQueryChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.48f),
        shape = RoundedCornerShape(18.dp),
        modifier = modifier.height(48.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                painter = painterResource(R.drawable.search_24px),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                decorationBox = { innerTextField ->
                    if (query.isBlank()) {
                        Text(
                            text = "Search exam, sheet, or student",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.68f)
                        )
                    }
                    innerTextField()
                }
            )
        }
    }
}

@Composable
private fun ScanRecordRow(
    record: ScanRecord,
    onPreview: () -> Unit,
    onDelete: () -> Unit
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(22.dp),
        tonalElevation = 1.dp,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onPreview)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.size(42.dp)
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        painter = painterResource(R.drawable.image_24px),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.size(20.dp)
                    )
                }
            }

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Text(
                    text = buildRowLabel(record),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1
                )
                Text(
                    text = buildRowMeta(record),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f),
                    maxLines = 1
                )
            }

            IconButton(onClick = onDelete) {
                Icon(
                    painter = painterResource(R.drawable.close_24px),
                    contentDescription = "Delete record",
                    tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.28f),
                    modifier = Modifier.size(16.dp)
                )
            }
        }
    }
}

@Composable
private fun FilterBottomSheet(
    availableCourses: List<String>,
    selectedCourse: String?,
    sortOrder: SortOrder,
    onCourseSelected: (String?) -> Unit,
    onSortOrderSelected: (SortOrder) -> Unit,
    onDismiss: () -> Unit
) {
    val courses = if (availableCourses.isEmpty()) {
        listOf("BSIT", "BSED", "BSCRIM", "BSBA", "BSHM")
    } else {
        availableCourses
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 10.dp)
                .padding(bottom = 22.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .width(38.dp)
                    .height(4.dp)
                    .clip(RoundedCornerShape(50))
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.35f))
            )

            Text(
                text = "Filter by",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface
            )

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Courses",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f)
                )
                FlowCourseChips(
                    courses = courses.take(8),
                    selectedCourse = selectedCourse,
                    onCourseSelected = onCourseSelected
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Sort by",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f)
                )
                SortOptionCard(
                    label = "Name (A-Z)",
                    selected = sortOrder == SortOrder.NAME_ASC,
                    onClick = { onSortOrderSelected(SortOrder.NAME_ASC) }
                )
                SortOptionCard(
                    label = "Name (Z-A)",
                    selected = sortOrder == SortOrder.NAME_DESC,
                    onClick = { onSortOrderSelected(SortOrder.NAME_DESC) }
                )
            }
        }
    }
}

@Composable
private fun FlowCourseChips(
    courses: List<String>,
    selectedCourse: String?,
    onCourseSelected: (String?) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        var index = 0
        while (index < courses.size) {
            val rowItems = courses.drop(index).take(5)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                rowItems.forEach { course ->
                    val selected = selectedCourse == course
                    Surface(
                        color = if (selected) {
                            MaterialTheme.colorScheme.secondaryContainer
                        } else {
                            MaterialTheme.colorScheme.surface
                        },
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .border(
                                1.dp,
                                MaterialTheme.colorScheme.outline.copy(alpha = 0.35f),
                                RoundedCornerShape(8.dp)
                            )
                            .clickable { onCourseSelected(if (selected) null else course) }
                    ) {
                        Text(
                            text = course,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (selected) {
                                MaterialTheme.colorScheme.onSecondaryContainer
                            } else {
                                MaterialTheme.colorScheme.onSurface
                            }
                        )
                    }
                }
            }
            index += 5
        }
    }
}

@Composable
private fun SortOptionCard(
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    Surface(
        color = if (selected) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.42f)
        },
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .border(
                width = 1.dp,
                color = if (selected) Color.Transparent else MaterialTheme.colorScheme.outline.copy(alpha = 0.35f),
                shape = RoundedCornerShape(20.dp)
            )
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.titleMedium,
                color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
            )
            Surface(
                color = Color.Transparent,
                shape = CircleShape,
                modifier = Modifier
                    .size(18.dp)
                    .border(
                        width = 1.dp,
                        color = if (selected) {
                            MaterialTheme.colorScheme.onPrimary
                        } else {
                            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                        },
                        shape = CircleShape
                    )
            ) {
                if (selected) {
                    Box(
                        modifier = Modifier
                            .padding(4.dp)
                            .fillMaxSize()
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.onPrimary)
                    )
                }
            }
        }
    }
}

@Composable
private fun SoftStatusChip(
    text: String,
    iconRes: Int? = null,
    modifier: Modifier = Modifier
) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = RoundedCornerShape(16.dp),
        modifier = modifier
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            if (iconRes != null) {
                Icon(
                    painter = painterResource(iconRes),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(12.dp)
                )
            }
            Text(
                text = text,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
        }
    }
}

@Composable
private fun SettingsScreen(
    apiBaseUrl: String,
    serverConnectionStatus: ServerConnectionStatus,
    onTestConnection: (String) -> Unit,
    onSave: (String) -> Unit
) {
    var localValue by rememberSaveable(apiBaseUrl) { mutableStateOf(apiBaseUrl) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = "Settings",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground
            )
            Text(
                text = "Scanner upload and web inbox connection",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.62f)
            )
        }

        Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = RoundedCornerShape(28.dp),
            tonalElevation = 2.dp,
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer,
                        shape = CircleShape,
                        modifier = Modifier.size(42.dp)
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                painter = painterResource(R.drawable.database_upload_24px),
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                    }
                    Column {
                        Text(
                            text = "Web app URL",
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            text = "Used when uploading captured papers.",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
                        )
                    }
                }

                OutlinedTextField(
                    value = localValue,
                    onValueChange = { localValue = it },
                    label = { Text("API base URL") },
                    placeholder = { Text("http://10.0.2.2:3000/") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(18.dp)
                )

                ConnectionStatusChip(status = serverConnectionStatus)

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    UrlPresetButton(
                        label = "Emulator",
                        value = "http://10.0.2.2:3000/",
                        onSelected = { localValue = it }
                    )
                    UrlPresetButton(
                        label = "Phone LAN",
                        value = "http://192.168.1.1:3000/",
                        onSelected = { localValue = it }
                    )
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Button(
                        onClick = { onSave(localValue) },
                        shape = RoundedCornerShape(18.dp)
                    ) {
                        Text("Save URL")
                    }
                    TextButton(onClick = { onTestConnection(localValue) }) {
                        Text("Test")
                    }
                }
            }
        }

        Surface(
            color = MaterialTheme.colorScheme.surface,
            shape = RoundedCornerShape(28.dp),
            tonalElevation = 2.dp,
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Text(
                    text = "Capture pipeline",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface
                )

                SettingsInfoRow(
                    iconRes = R.drawable.photo_camera_24px,
                    title = "Document detection",
                    value = "Live green paper outline"
                )
                SettingsInfoRow(
                    iconRes = R.drawable.image_24px,
                    title = "Saved output",
                    value = "Portrait 1632 x 2496 JPG"
                )
                SettingsInfoRow(
                    iconRes = R.drawable.database_24px,
                    title = "Upload destination",
                    value = "/api/received-papers"
                )
                SettingsInfoRow(
                    iconRes = R.drawable.search_24px,
                    title = "Scoring",
                    value = "Handled by web OMR after upload"
                )
            }
        }
    }
}

@Composable
private fun UrlPresetButton(
    label: String,
    value: String,
    onSelected: (String) -> Unit
) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.clickable { onSelected(value) }
    ) {
        Text(
            text = label,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSecondaryContainer
        )
    }
}

@Composable
private fun SettingsInfoRow(
    iconRes: Int,
    title: String,
    value: String
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.64f),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.size(42.dp)
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    painter = painterResource(iconRes),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp)
                )
            }
        }
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurface
            )
            Text(
                text = value,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.62f)
            )
        }
    }
}

@Composable
private fun EditRecordDialog(
    record: ScanRecord,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit
) {
    var studentName by rememberSaveable(record.id) { mutableStateOf(record.studentName) }
    var course by rememberSaveable(record.id) { mutableStateOf(record.course) }

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = { onSave(studentName, course) }) {
                Text("Save")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
        title = { Text("Edit scan record") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = studentName,
                    onValueChange = { studentName = it },
                    label = { Text("Student name") },
                    singleLine = true
                )
                OutlinedTextField(
                    value = course,
                    onValueChange = { course = it },
                    label = { Text("Course") },
                    singleLine = true
                )
            }
        }
    )
}

@Composable
private fun DeleteRecordDialog(
    record: ScanRecord,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = onConfirm) {
                Text("Delete")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        },
        title = { Text("Delete record") },
        text = {
            Text("Remove ${record.studentName.ifBlank { "this scan" }} from the local database and delete its image?")
        }
    )
}

@Composable
private fun PreviewDialog(
    record: ScanRecord,
    onDismiss: () -> Unit,
    onEdit: () -> Unit
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.88f))
                .padding(20.dp)
        ) {
            IconButton(
                onClick = onDismiss,
                modifier = Modifier.align(Alignment.TopEnd)
            ) {
                Icon(
                    painter = painterResource(R.drawable.close_24px),
                    contentDescription = "Close preview",
                    tint = MaterialTheme.colorScheme.inverseOnSurface
                )
            }

            val bitmap = remember(record.imagePath) {
                BitmapFactory.decodeFile(record.imagePath)?.asImageBitmap()
            }

            Column(
                modifier = Modifier
                    .align(Alignment.Center)
                    .fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    text = record.imageFileName,
                    color = MaterialTheme.colorScheme.inverseOnSurface,
                    style = MaterialTheme.typography.titleMedium,
                    textAlign = TextAlign.Center
                )

                if (bitmap != null) {
                    Image(
                        bitmap = bitmap,
                        contentDescription = "Captured scan preview",
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(28.dp)),
                        contentScale = ContentScale.Fit
                    )
                } else {
                    Text(
                        text = "Preview unavailable",
                        color = MaterialTheme.colorScheme.inverseOnSurface
                    )
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    TextButton(onClick = onDismiss) {
                        Text("Close", color = MaterialTheme.colorScheme.inverseOnSurface)
                    }
                    Surface(
                        color = MaterialTheme.colorScheme.primary,
                        shape = RoundedCornerShape(18.dp),
                        modifier = Modifier.clickable(onClick = onEdit)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            Icon(
                                painter = painterResource(R.drawable.image_24px),
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(14.dp)
                            )
                            Text(
                                text = "Edit details",
                                color = MaterialTheme.colorScheme.onPrimary,
                                style = MaterialTheme.typography.labelSmall
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun buildRowLabel(record: ScanRecord): String {
    val exam = record.examId?.takeIf { it.isNotBlank() } ?: "No exam QR"
    val sheet = record.sheetId?.takeIf { it.isNotBlank() } ?: "No sheet ID"
    return "$exam • $sheet"
}

private fun buildRowMeta(record: ScanRecord): String {
    val warning = record.needsReviewReason?.takeIf { it.isNotBlank() }?.let { " • Review" } ?: ""
    return "${record.status.name.lowercase().replace('_', ' ')}$warning"
}
