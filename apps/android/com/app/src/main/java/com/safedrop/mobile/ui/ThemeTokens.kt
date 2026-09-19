package com.safedrop.mobile.ui

import android.content.Context
import android.content.res.ColorStateList
import androidx.core.content.ContextCompat
import com.safedrop.mobile.R

/**
 * The single place the three appearance modes are turned into paint.
 *
 * Every value is a `@color` resource, so the palette lives in `res/values/colors.xml` next to the
 * desktop contract it has to match. Before this existed each theme branch repeated the same hex
 * literals in Kotlin - which is how the two ends drifted apart while the XML comment above them
 * still claimed the colours were "aligned with desktop".
 *
 * Modes differ only in surface polarity and in how far the semantic hues have to be lifted to
 * clear 4.5:1 against that surface. Ink, and the four state colours, are the same set everywhere.
 */
data class Palette(
    val page: Int,
    val surface: Int,
    val raised: Int,
    val hairline: Int,
    val ink: Int,
    val inkMuted: Int,
    val inkFaint: Int,
    val onInk: Int,
    val ready: Int,
    val active: Int,
    val attention: Int,
    val failure: Int
) {
    /** Filled control: ink as the plate, the page colour as the glyph knocked out of it. */
    val ctaBackground: Int get() = ink
    val ctaText: Int get() = onInk

    /** Text-shaped controls stay neutral - colour is reserved for state. */
    val quietText: Int get() = inkMuted

    fun states(color: Int) = ColorStateList.valueOf(color)

    companion object {
        const val DARK = "dark"
        const val EYECARE = "eyecare"
        const val LIGHT = "light"

        @Suppress("DEPRECATION")
        fun of(context: Context, mode: String): Palette {
            fun c(id: Int) = ContextCompat.getColor(context, id)
            return when (mode) {
                EYECARE -> Palette(
                    page = c(R.color.eyecare_background),
                    surface = c(R.color.eyecare_surface),
                    raised = c(R.color.eyecare_card),
                    hairline = c(R.color.eyecare_border),
                    ink = c(R.color.ink_on_paper),
                    inkMuted = c(R.color.eyecare_text_secondary),
                    inkFaint = c(R.color.eyecare_text_muted),
                    onInk = c(R.color.eyecare_background),
                    ready = c(R.color.state_ready),
                    active = c(R.color.state_active),
                    attention = c(R.color.state_attention),
                    failure = c(R.color.state_failure)
                )
                LIGHT -> Palette(
                    page = c(R.color.background_light),
                    surface = c(R.color.surface_light),
                    raised = c(R.color.surface_variant_light),
                    hairline = c(R.color.border_light),
                    ink = c(R.color.ink_on_paper),
                    inkMuted = c(R.color.text_secondary_light),
                    inkFaint = c(R.color.text_muted_light),
                    onInk = c(R.color.ink_inverse_on_paper),
                    ready = c(R.color.state_ready),
                    active = c(R.color.state_active),
                    attention = c(R.color.state_attention),
                    failure = c(R.color.state_failure)
                )
                else -> Palette(
                    page = c(R.color.background_dark),
                    surface = c(R.color.surface_dark),
                    raised = c(R.color.surface_variant_dark),
                    hairline = c(R.color.border_dark),
                    ink = c(R.color.ink),
                    inkMuted = c(R.color.ink_muted),
                    inkFaint = c(R.color.ink_faint),
                    onInk = c(R.color.ink_inverse),
                    // Lifted for legibility on #0B0D0F; the base hues stay the desktop values.
                    ready = c(R.color.state_ready_text),
                    active = c(R.color.state_active_text),
                    attention = c(R.color.state_attention_text),
                    failure = c(R.color.state_failure_text)
                )
            }
        }

        /** Full app theme for a mode, used when a dialog has to be painted like the activity. */
        fun themeRes(mode: String): Int = when (mode) {
            EYECARE -> R.style.Theme_SafeDrop_EyeCare
            LIGHT -> R.style.Theme_SafeDrop_Light
            else -> R.style.Theme_SafeDrop
        }
    }
}
