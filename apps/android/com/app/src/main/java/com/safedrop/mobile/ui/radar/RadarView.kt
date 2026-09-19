package com.safedrop.mobile.ui.radar

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.graphics.ColorUtils
import com.safedrop.mobile.ui.Palette

/**
 * Mobile High-Precision Dynamic Radar Canvas (RadarView)
 * Aligned with the desktop instrument (style.css `--radar-line` / `--radar-sweep` / `.radar-blip`):
 * 1. 4 concentric distance range rings: 5m, 15m, 30m, 50m with range labels - hairline
 * 2. Crosshair axes with micro-ticks - the same hairline, as on desktop where both are --radar-line
 * 3. 360-degree rotating sweep beam with 40-degree tail - translucent muted ink, never a colour glow
 * 4. Periodic sonar wave expansion ripples - hairline: scanning is not a state
 * 5. Dynamic theme support for Dark, EyeCare, and Light by way of [Palette], so a mode flip moves
 *    surfaces and nothing else
 * 6. Online desktop device beacon node rendering on 15m orbit - the one `ready` hue on the canvas
 *
 * No colour is named in this file. Every paint is a [Palette] token, or a token with an alpha
 * applied by [translucent], which is what stops the two ends of the product from each keeping
 * their own idea of what the radar looks like.
 */
class RadarView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var scanAngle = 0f
    private var waveProgress = 0f
    private var currentTheme = Palette.DARK

    /** Paint for the current mode. Only [applyThemeColors] replaces it, and only on a mode change. */
    private var palette = Palette.of(context, currentTheme)

    private var connectedIp: String? = null
    private var connectedName: String? = null

    // 4 concentric range labels aligned with desktop hub
    private val distanceLabels = listOf("5m", "15m", "30m", "50m")

    // The sweep's tail-to-head alpha ramp, applied to `inkMuted` - the token colors.xml names
    // radar_scan_beam. Desktop's --radar-sweep is a neutral at 8-10% across its whole conic
    // gradient; this canvas fills a far larger disc, so the head keeps half of the 40% it used to
    // carry and the tail stays as faint as it was. Same ramp shape, no hue, no glow.
    private companion object {
        const val SWEEP_TAIL_ALPHA = 16
        const val SWEEP_HEAD_ALPHA = 64
    }

    // Structure paints: rings, axes, the pings that mean "still looking", and the labels.
    private val circlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
    }

    private val crosshairPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
    }

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 24f
        textAlign = Paint.Align.LEFT
    }

    private val wavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f
    }

    // The local node: a neutral plate with the surface knocked out of it, like .hub-avatar.
    private val centerDotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    // State paint: a peer that is actually there, and the sonar circle announcing it.
    private val beaconPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val beaconWavePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
    }

    private var animator: ValueAnimator? = null

    init {
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

    /** A token with an alpha applied. Translucent ink is still ink, so no new colour appears. */
    private fun translucent(color: Int, alpha: Int) = ColorUtils.setAlphaComponent(color, alpha)

    private fun applyThemeColors() {
        palette = Palette.of(context, currentTheme)
        val p = palette
        circlePaint.color = p.hairline
        crosshairPaint.color = p.hairline
        wavePaint.color = p.hairline
        textPaint.color = p.inkFaint
        centerDotPaint.color = p.ink
        beaconPaint.color = p.ready
        beaconWavePaint.color = p.ready
    }

    private var animating = false

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        resumeSweep()
    }

    /**
     * The dial only earns a frame callback while the user can see it. This callback covers
     * visibility, window focus and screen state together, which is what stops a phone from
     * redrawing a spinning radar behind another page or with the screen in its pocket - in an app
     * that spends a whole dialog asking OEMs not to kill it in the background.
     */
    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (isVisible) resumeSweep() else pauseSweep()
    }

    override fun onDetachedFromWindow() {
        pauseSweep()
        super.onDetachedFromWindow()
    }

    private fun resumeSweep() {
        if (animating || !isAttachedToWindow) return
        if (!ValueAnimator.areAnimatorsEnabled()) {
            // Animator duration scale is off: a loop that invalidates a picture which can never
            // move is pure battery drain, so draw one static frame and stop.
            scanAngle = 0f
            waveProgress = 0f
            invalidate()
            return
        }
        animating = true
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

    /**
     * Cancel and drop rather than pause-and-resume: the next sweep is built fresh, so there is no
     * question of restarting an animator the framework has already finished with. The sweep
     * restarting at the top of its arc reads as a rescan, not a glitch.
     */
    private fun pauseSweep() {
        animating = false
        animator?.cancel()
        animator = null
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

        // 3. Draw 360-degree rotating sweep beam with gradient tail: structure, so it is a
        // muted neutral, and it is the same one in all three modes.
        canvas.save()
        canvas.rotate(scanAngle, cx, cy)

        val sweepStartColor = translucent(palette.inkMuted, SWEEP_TAIL_ALPHA)
        val sweepEndColor = translucent(palette.inkMuted, SWEEP_HEAD_ALPHA)

        val shader = SweepGradient(
            cx, cy,
            intArrayOf(Color.TRANSPARENT, sweepStartColor, sweepEndColor),
            floatArrayOf(0f, 0.85f, 1f)
        )
        sweepPaint.shader = shader
        canvas.drawCircle(cx, cy, maxRadius, sweepPaint)
        canvas.restore()

        // 4. Draw dual expanding sonar ripples: the dial looking, which is not a state, so the
        // old sky/emerald/blue ping is now the same hairline the rings are drawn with.
        for (offset in listOf(0f, 0.5f)) {
            val p = (waveProgress + offset) % 1f
            val waveR = maxRadius * p
            val alpha = ((1f - p) * 180).toInt().coerceIn(0, 255)
            wavePaint.color = translucent(palette.hairline, alpha)
            canvas.drawCircle(cx, cy, waveR, wavePaint)
        }

        // 5. Draw center local device node: an ink plate, knocked out with the surface behind it.
        canvas.drawCircle(cx, cy, 12f, centerDotPaint)
        centerDotPaint.color = palette.surface
        canvas.drawCircle(cx, cy, 5f, centerDotPaint)
        centerDotPaint.color = palette.ink

        // 6. If connected to desktop hub, render beacon on 15m orbit
        if (!connectedIp.isNullOrEmpty()) {
            val targetRadius = maxRadius * (2f / 4f) // 15m orbit
            val angleRad = Math.toRadians(-45.0)
            val bx = (cx + targetRadius * Math.cos(angleRad)).toFloat()
            val by = (cy + targetRadius * Math.sin(angleRad)).toFloat()

            // Pulsing sonar circle
            val beaconWaveR = 14f + (waveProgress * 22f)
            val beaconAlpha = ((1f - waveProgress) * 220).toInt().coerceIn(0, 255)
            beaconWavePaint.color = translucent(palette.ready, beaconAlpha)
            canvas.drawCircle(bx, by, beaconWaveR, beaconWavePaint)

            // Beacon center dot: the one hue on this dial, because a peer is really there.
            beaconPaint.color = palette.ready
            canvas.drawCircle(bx, by, 9f, beaconPaint)
            beaconPaint.color = palette.surface
            canvas.drawCircle(bx, by, 4f, beaconPaint)

            // Device label
            val deviceLabel = connectedName ?: connectedIp ?: "PC"
            canvas.drawText(deviceLabel, bx + 14f, by + 6f, textPaint)
        }
    }
}
