package com.scan.scancheckerapp.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme = darkColorScheme(
    primary = Mist,
    secondary = RoseMist,
    tertiary = SoftLilac,
    background = Ink,
    surface = Color(0xFF201A2B),
    onPrimary = Ink,
    onSecondary = Ink,
    onBackground = Shell,
    onSurface = Shell
)

private val LightColorScheme = lightColorScheme(
    primary = Lavender,
    secondary = Mist,
    tertiary = RoseMist,
    background = SoftLilac,
    surface = Shell,
    onPrimary = Shell,
    onSecondary = Ink,
    onTertiary = Ink,
    onBackground = Ink,
    onSurface = Ink
)

@Composable
fun ScanCheckerAppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }

        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
