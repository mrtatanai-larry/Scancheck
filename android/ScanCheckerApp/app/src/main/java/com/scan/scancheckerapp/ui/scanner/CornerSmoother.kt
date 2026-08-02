package com.scan.scancheckerapp.ui.scanner

import org.opencv.core.Point
import kotlin.math.sqrt

class CornerSmoother(private val bufferSize: Int = 5) {
    private val history = mutableListOf<List<Point>>()
    private val maxJumpDistance = 50.0 // Pixels

    fun smooth(newCorners: List<Point>?): List<Point>? {
        if (newCorners == null) {
            if (history.isNotEmpty()) history.removeAt(0)
            return null
        }

        if (history.isNotEmpty()) {
            val lastCorners = history.last()
            var totalDist = 0.0
            for (i in 0 until 4) {
                totalDist += distance(lastCorners[i], newCorners[i])
            }
            // Ignore sudden large jumps (noise)
            if (totalDist > maxJumpDistance * 4) {
                return lastCorners
            }
        }

        history.add(newCorners)
        if (history.size > bufferSize) {
            history.removeAt(0)
        }

        return calculateAverage()
    }

    private fun calculateAverage(): List<Point> {
        val avg = List(4) { Point(0.0, 0.0) }
        for (corners in history) {
            for (i in 0 until 4) {
                avg[i].x += corners[i].x
                avg[i].y += corners[i].y
            }
        }
        for (i in 0 until 4) {
            avg[i].x /= history.size
            avg[i].y /= history.size
        }
        return avg
    }

    private fun distance(p1: Point, p2: Point): Double {
        return sqrt((p1.x - p2.x).pow(2.0) + (p1.y - p2.y).pow(2.0))
    }

    private fun Double.pow(n: Double) = Math.pow(this, n)
}
