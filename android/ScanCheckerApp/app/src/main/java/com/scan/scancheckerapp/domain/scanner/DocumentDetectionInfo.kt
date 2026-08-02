package com.scan.scancheckerapp.domain.scanner

import org.opencv.core.Point

/**
 * Holds the result of a live document detection pass.
 *
 * * corners – the four detected points in image coordinates (order: TL, TR, BR, BL)
 * * confidence – proportion of the image area covered by the detected contour (0..1)
 * * blurScore – variance of the Laplacian (higher is sharper)
 * * brightness – average luminance of the sampled pixels (0..255)
 * * tiltDegrees – absolute angle of the top edge relative to the horizontal axis
 * * isAcceptable – true when all quality thresholds are met.
 */
data class DocumentDetectionInfo(
    val corners: List<Point>?,
    val confidence: Double,
    val blurScore: Double,
    val brightness: Double,
    val tiltDegrees: Double,
    val isAcceptable: Boolean
)
