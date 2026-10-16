// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.content.Context
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.HorizontalScrollView
import android.widget.LinearLayout

/** Plain views built in code: the spike has no layouts or themes worth a resource file. */
object Ui {
    fun dp(context: Context, value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

    fun column(context: Context): LinearLayout =
        LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    /** A horizontally scrolling row, so long button rows still fit a phone in portrait. */
    fun row(context: Context, vararg views: View): View {
        val row = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        views.forEach { row.addView(it) }
        return HorizontalScrollView(context).apply { addView(row) }
    }

    /** Pads the root by the system bars: target SDK 35+ draws edge to edge. */
    fun withInsets(root: ViewGroup): ViewGroup {
        root.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(
                    insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom,
                )
            }
            insets
        }
        return root
    }
}
