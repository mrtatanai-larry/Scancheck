package com.todobom.opennotescanner.scancheck.ui

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.todobom.opennotescanner.OpenNoteScannerActivity
import com.todobom.opennotescanner.R
import com.todobom.opennotescanner.SettingsActivity
import com.todobom.opennotescanner.scancheck.data.local.ScanRecord

private val ScreenBg = Color(0xFFF6EDF7)
private val Shell = Color(0xFFFFFAFF)
private val Ink = Color(0xFF2F293B)
private val Muted = Color(0xFF756D83)
private val Mist = Color(0xFFE8DEEA)
private val Lavender = Color(0xFF5B536C)

@Composable
fun ScanCheckTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            background = ScreenBg,
            surface = Shell,
            primary = Lavender,
            onPrimary = Shell,
            onSurface = Ink
        ),
        content = content
    )
}

@Composable
fun ScanCheckResultsScreen(
    viewModel: ScanCheckViewModel = scanCheckViewModel()
) {
    val context = LocalContext.current
    val state by viewModel.uiState.collectAsState()

    MessageToast(state.message, viewModel::consumeMessage)

    ScreenScaffold(
        selected = "Captured",
        onCapture = {
            context.startActivity(Intent(context, OpenNoteScannerActivity::class.java))
        },
        onResults = {},
        onSettings = {
            context.startActivity(Intent(context, ScanCheckSettingsActivity::class.java))
        }
    ) {
        Text(
            text = "Scan Results",
            style = MaterialTheme.typography.headlineSmall,
            color = Ink
        )
        Spacer(modifier = Modifier.height(18.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            SearchBox(
                query = state.searchQuery,
                onQueryChange = viewModel::updateSearchQuery,
                modifier = Modifier.weight(1f)
            )
            UploadButton(onClick = viewModel::uploadPendingRecords)
        }
        Spacer(modifier = Modifier.height(14.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            StatusChip("Pending uploads: ${state.pendingUploadCount}")
            CircleIconButton(R.drawable.scancheck_sort_24px, onClick = {})
        }
        Spacer(modifier = Modifier.height(14.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.records, key = { it.id }) { record ->
                ResultRow(record = record, onDelete = { viewModel.deleteRecord(record) })
            }
        }
    }
}

@Composable
fun ScanCheckSettingsScreen(
    viewModel: ScanCheckViewModel = scanCheckViewModel()
) {
    val context = LocalContext.current
    val state by viewModel.uiState.collectAsState()
    var showUrlDialog by remember { mutableStateOf(false) }
    var showAboutDialog by remember { mutableStateOf(false) }

    MessageToast(state.message, viewModel::consumeMessage)

    ScreenScaffold(
        selected = "Settings",
        onCapture = {
            context.startActivity(Intent(context, OpenNoteScannerActivity::class.java))
        },
        onResults = {
            context.startActivity(Intent(context, ScanCheckResultsActivity::class.java))
        },
        onSettings = {}
    ) {
        Text(
            text = "Settings",
            style = MaterialTheme.typography.headlineSmall,
            color = Ink
        )
        Spacer(modifier = Modifier.height(18.dp))
        Surface(color = Shell, shape = RoundedCornerShape(22.dp), modifier = Modifier.fillMaxWidth()) {
            Column {
                SettingsItem(
                    icon = R.drawable.scancheck_database_24px,
                    text = "Set the ScanCheck web app URL used for upload.",
                    onClick = { showUrlDialog = true }
                )
                SettingsDivider()
                SettingsItem(
                    icon = R.drawable.scancheck_settings_24px,
                    text = "Check Server Connection",
                    onClick = viewModel::checkServerConnection
                )
                SettingsDivider()
                SettingsItem(
                    icon = R.drawable.scancheck_school_24px,
                    text = "OpenNote Scanner Settings",
                    onClick = { context.startActivity(Intent(context, SettingsActivity::class.java)) }
                )
                SettingsDivider()
                SettingsItem(
                    icon = R.drawable.scancheck_school_24px,
                    text = "About",
                    onClick = { showAboutDialog = true }
                )
            }
        }
        Spacer(modifier = Modifier.height(14.dp))
        Text(
            text = when (state.serverConnectionStatus) {
                ServerConnectionStatus.CHECKING -> "Checking server..."
                ServerConnectionStatus.CONNECTED -> "Connected to server"
                ServerConnectionStatus.DISCONNECTED -> "Not connected to server"
            },
            color = Muted,
            style = MaterialTheme.typography.bodyMedium
        )
    }

    if (showUrlDialog) {
        UrlDialog(
            currentUrl = state.apiBaseUrl,
            onDismiss = { showUrlDialog = false },
            onSave = {
                viewModel.saveApiBaseUrl(it)
                showUrlDialog = false
            }
        )
    }

    if (showAboutDialog) {
        AlertDialog(
            onDismissRequest = { showAboutDialog = false },
            title = { Text("About") },
            text = { Text("OpenNote Scanner camera with ScanCheck results and upload structure.") },
            confirmButton = {
                TextButton(onClick = { showAboutDialog = false }) {
                    Text("Close")
                }
            }
        )
    }
}

@Composable
private fun ScreenScaffold(
    selected: String,
    onCapture: () -> Unit,
    onResults: () -> Unit,
    onSettings: () -> Unit,
    content: @Composable Column.() -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ScreenBg)
            .navigationBarsPadding()
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 20.dp, vertical = 34.dp)
                .padding(bottom = 88.dp),
            content = content
        )
        BottomNav(
            selected = selected,
            onCapture = onCapture,
            onResults = onResults,
            onSettings = onSettings,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 20.dp)
        )
    }
}

@Composable
private fun BottomNav(
    selected: String,
    onCapture: () -> Unit,
    onResults: () -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Surface(
            color = Lavender,
            shape = CircleShape,
            modifier = Modifier.size(56.dp).clickable(onClick = onCapture)
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.scancheck_photo_camera_24px), null, tint = Shell)
            }
        }
        Surface(color = Lavender, shape = RoundedCornerShape(30.dp)) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                NavPill("Captured", R.drawable.scancheck_database_24px, selected == "Captured", onResults)
                NavPill("Settings", R.drawable.scancheck_settings_24px, selected == "Settings", onSettings)
            }
        }
    }
}

@Composable
private fun NavPill(text: String, icon: Int, selected: Boolean, onClick: () -> Unit) {
    Surface(
        color = if (selected) Shell else Color.Transparent,
        shape = RoundedCornerShape(24.dp),
        modifier = Modifier.clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = if (selected) 14.dp else 10.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (selected) {
                Text(text, color = Ink, style = MaterialTheme.typography.labelMedium)
            }
            Icon(painterResource(icon), null, tint = if (selected) Ink else Shell, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun SearchBox(query: String, onQueryChange: (String) -> Unit, modifier: Modifier = Modifier) {
    Surface(color = Color.Transparent, shape = RoundedCornerShape(18.dp), modifier = modifier.border(1.dp, Mist, RoundedCornerShape(18.dp))) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(painterResource(R.drawable.scancheck_search_24px), null, tint = Muted, modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(8.dp))
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                textStyle = MaterialTheme.typography.bodySmall.copy(color = Ink),
                decorationBox = { inner ->
                    if (query.isBlank()) Text("Search name", color = Muted, style = MaterialTheme.typography.bodySmall)
                    inner()
                }
            )
        }
    }
}

@Composable
private fun UploadButton(onClick: () -> Unit) {
    Surface(color = Color.Transparent, shape = RoundedCornerShape(18.dp), modifier = Modifier.border(1.dp, Mist, RoundedCornerShape(18.dp)).clickable(onClick = onClick)) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text("Upload", color = Ink, style = MaterialTheme.typography.labelSmall)
            Icon(painterResource(R.drawable.scancheck_database_upload_24px), null, tint = Ink, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
private fun StatusChip(text: String) {
    Surface(color = Mist.copy(alpha = 0.6f), shape = RoundedCornerShape(14.dp)) {
        Text(text, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp), color = Muted, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun CircleIconButton(icon: Int, onClick: () -> Unit) {
    Surface(color = Mist.copy(alpha = 0.45f), shape = CircleShape, modifier = Modifier.size(40.dp).clickable(onClick = onClick)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), null, tint = Lavender, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun ResultRow(record: ScanRecord, onDelete: () -> Unit) {
    Surface(color = Shell, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Surface(color = Mist.copy(alpha = 0.55f), shape = RoundedCornerShape(12.dp), modifier = Modifier.size(40.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.scancheck_database_24px), null, tint = Lavender, modifier = Modifier.size(18.dp))
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(record.sheetId ?: record.imageFileName.substringBeforeLast("."), color = Ink, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${record.status.name.replace('_', ' ')} | ${record.studentName.ifBlank { "Unknown" }} | ${record.course.ifBlank { "Unassigned Course" }}", color = Muted, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            CircleIconButton(R.drawable.scancheck_close_24px, onDelete)
        }
    }
}

@Composable
private fun SettingsItem(icon: Int, text: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        Surface(color = Mist.copy(alpha = 0.5f), shape = CircleShape, modifier = Modifier.size(38.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(painterResource(icon), null, tint = Lavender, modifier = Modifier.size(18.dp))
            }
        }
        Text(text, color = Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
        Icon(painterResource(R.drawable.scancheck_keyboard_arrow_right_24px), null, tint = Muted, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun SettingsDivider() {
    Box(modifier = Modifier.padding(start = 68.dp, end = 16.dp).fillMaxWidth().height(1.dp).background(Mist.copy(alpha = 0.65f)))
}

@Composable
private fun UrlDialog(currentUrl: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var value by remember(currentUrl) { mutableStateOf(currentUrl) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit API URL") },
        text = {
            BasicTextField(
                value = value,
                onValueChange = { value = it },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().border(1.dp, Mist, RoundedCornerShape(10.dp)).padding(12.dp),
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = Ink)
            )
        },
        confirmButton = { TextButton(onClick = { onSave(value) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun MessageToast(message: String?, onShown: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(message) {
        if (!message.isNullOrBlank()) {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
            onShown()
        }
    }
}

@Composable
private fun scanCheckViewModel(): ScanCheckViewModel {
    val context = LocalContext.current
    return viewModel(factory = ScanCheckViewModelFactory(context.applicationContext as android.app.Application))
}
