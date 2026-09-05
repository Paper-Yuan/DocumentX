package com.safedrop.mobile.ui.radar

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator

/**
 * Mobile High-Precision Dynamic Radar Canvas (RadarView)
 * Aligned 1:1 with desktop specifications:
 * 1. 4 concentric distance range rings: 5m, 15m, 30m, 50m with range labels
 * 2. Crosshair axes with micro-ticks
 * 3. 360-degree rotating sweep gradient beam with 40-degree tail
 * 4. Periodic sonar wave expansion ripples
 * 5. Dynamic theme support for Dark, EyeCare, and Light color modes
 * 6. Online desktop device beacon node rendering on 15m orbit
 */
class RadarView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var scanAngle = 0f
    private var waveProgress = 0f
    private var currentTheme = "dark" // "dark" | "eyecare" | "light"

    private var connectedIp: String? = null
    private var connectedName: String? = null

    // 4 concentric range labels aligned with desktop hub
    private val distanceLabels = listOf("5m", "15m", "30m", "50m")

    private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
        color = Color.parseColor("#334155")
    }

    private val crosshairPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
        color = Color.parseColor("#334155")
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 24f
        color = Color.parseColor("#64748B")
        textAlign = Paint.Align.LEFT
    }

    private val wavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }

    private val centerDotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.parseColor("#6366F1")
    }

    private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val beaconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.parseColor("#10B981")
    }

    private val beaconWavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
        color = Color.parseColor("#10B981")
    }

    private var animator: ValueAnimator? = null

    init {
        startAnimation()
        applyThemeColors()
    }

    fun setThemeMode(theme: String) {
        currentTheme = theme
        applyThemeColors()
        invalidate()
    }

    fun setConnectedDevice(ip: String?, name: String? = null) {
        connectedIp = ip
        connectedName = name ?: if (ip != null) "Desktop Hub" else null
        invalidate()
    }

    private fun applyThemeColors() {
        when (currentTheme) {
            "eyecare" -> {
                circlePaint.color = Color.parseColor("#D8D3C5")
                crosshairPaint.color = Color.parseColor("#C8C3B5")
                textPaint.color = Color.parseColor("#5C6D62")
                centerDotPaint.color = Color.parseColor("#2E7D56")
            }
            "light" -> {
                circlePaint.color = Color.parseColor("#E2E8F0")
                crosshairPaint.color = Color.parseColor("#CBD5E1")
                textPaint.color = Color.parseColor("#64748B")
                centerDotPaint.color = Color.parseColor("#2563EB")
            }
            else -> { // dark
                circlePaint.color = Color.parseColor("#334155")
                crosshairPaint.color = Color.parseColor("#1E293B")
                textPaint.color = Color.parseColor("#64748B")
                centerDotPaint.color = Color.parseColor("#6366F1")
            }
        }
    }

    private fun startAnimation() {
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 3200
            repeatCount = ValueAnimator.INFINITE
            interpolator = LinearInterpolator()
            addUpdateListener { animation ->
                val v = animation.animatedValue as Float
                scanAngle = (v * 360f) % 360f
                waveProgress = v
                invalidate()
            }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val maxRadius = (minOf(width, height) / 2f) - 24f
        if (maxRadius <= 0) return

        // 1. Draw 4 concentric distance range rings (5m, 15m, 30m, 50m)
        val ringCount = 4
        for (i in 1..ringCount) {
            val r = maxRadius * (i / ringCount.toFloat())
            canvas.drawCircle(cx, cy, r, circlePaint)

            // Draw distance text label along vertical axis
            val label = distanceLabels.getOrElse(i - 1) { "${i * 10}m" }
            canvas.drawText(label, cx + 8f, cy - r + 26f, textPaint)
        }

        // 2. Draw crosshair axes and micro ticks
        canvas.drawLine(cx - maxRadius, cy, cx + maxRadius, cy, crosshairPaint)
        canvas.drawLine(cx, cy - maxRadius, cx, cy + maxRadius, crosshairPaint)

        val tickSize = 6f
        for (i in 1..ringCount) {
            val r = maxRadius * (i / ringCount.toFloat())
            canvas.drawLine(cx + r, cy - tickSize, cx + r, cy + tickSize, crosshairPaint)
            canvas.drawLine(cx - r, cy - tickSize, cx - r, cy + tickSize, crosshairPaint)
            canvas.drawLine(cx - tickSize, cy + r, cx + tickSize, cy + r, crosshairPaint)
            canvas.drawLine(cx - tickSize, cy - r, cx + tickSize, cy - r, crosshairPaint)
        }

        // 3. Draw 360-degree rotating sweep beam with gradient tail
        canvas.save()
        canvas.rotate(scanAngle, cx, cy)

        val sweepStartColor: Int
        val sweepEndColor: Int
        when (currentTheme) {
            "eyecare" -> {
                sweepStartColor = Color.parseColor("#152E7D56")
                sweepEndColor = Color.parseColor("#7052B788")
            }
            "light" -> {
                sweepStartColor = Color.parseColor("#152563EB")
                sweepEndColor = Color.parseColor("#603B82F6")
            }
            else -> {
                sweepStartColor = Color.parseColor("#1238BDF8")
                sweepEndColor = Color.parseColor("#6538BDF8")
            }
        }

        val shader = SweepGradient(
            cx, cy,
            intArrayOf(Color.TRANSPARENT, sweepStartColor, sweepEndColor),
            floatArrayOf(0f, 0.85f, 1f)
        )
        sweepPaint.shader = shader
        canvas.drawCircle(cx, cy, maxRadius, sweepPaint)
        canvas.restore()

        // 4. Draw dual expanding sonar ripples
        val waveColorHex = when (currentTheme) {
            "eyecare" -> "#52B788"
            "light" -> "#3B82F6"
            else -> "#38BDF8"
        }
        for (offset in listOf(0f, 0.5f)) {
            val p = (waveProgress + offset) % 1f
            val waveR = maxRadius * p
            val alpha = ((1f - p) * 180).toInt().coerceIn(0, 255)
            wavePaint.color = Color.parseColor(waveColorHex)
            wavePaint.alpha = alpha
            canvas.drawCircle(cx, cy, waveR, wavePaint)
        }

        // 5. Draw center local device node
        canvas.drawCircle(cx, cy, 12f, centerDotPaint)
        centerDotPaint.color = Color.WHITE
        canvas.drawCircle(cx, cy, 5f, centerDotPaint)
        applyThemeColors()

        // 6. If connected to desktop hub, render beacon on 15m orbit
        if (!connectedIp.isNullOrEmpty()) {
            val targetRadius = maxRadius * (2f / 4f) // 15m orbit
            val angleRad = Math.toRadians(-45.0)
            val bx = (cx + targetRadius * Math.cos(angleRad)).toFloat()
            val by = (cy + targetRadius * Math.sin(angleRad)).toFloat()

            // Pulsing sonar circle
            val beaconWaveR = 14f + (waveProgress * 22f)
            val beaconAlpha = ((1f - waveProgress) * 220).toInt().coerceIn(0, 255)
            beaconWavePaint.alpha = beaconAlpha
            canvas.drawCircle(bx, by, beaconWaveR, beaconWavePaint)

            // Beacon center dot
            beaconPaint.color = Color.parseColor("#10B981")
            canvas.drawCircle(bx, by, 9f, beaconPaint)
            beaconPaint.color = Color.WHITE
            canvas.drawCircle(bx, by, 4f, beaconPaint)

            // Device label
            val deviceLabel = connectedName ?: connectedIp ?: "PC"
            canvas.drawText(deviceLabel, bx + 14f, by + 6f, textPaint)
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animator?.cancel()
    }
}
