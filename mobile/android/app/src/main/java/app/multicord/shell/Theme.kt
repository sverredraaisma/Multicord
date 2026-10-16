// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

/**
 * The theme setting (src/shared/settings.ts, Theme) on the native side: the screen behind the pages and
 * the system bars. The pages apply it themselves (data-theme, from the shell page and through each chat
 * view's bridge); with "system" they follow prefers-color-scheme, which the WebView takes from the app's
 * DayNight theme, so from the phone's dark theme setting.
 */
object Theme {
    /** The pages' --bg in each theme (static/shell.css). */
    const val DARK_BACKGROUND = 0xFF1E1F22.toInt()
    const val LIGHT_BACKGROUND = 0xFFE3E5E8.toInt()

    /** Whether the screen is dark: as chosen, or as the phone is now (`systemNight`) when the setting follows it. */
    fun isDark(theme: String, systemNight: Boolean): Boolean = when (theme) {
        "light" -> false
        "dark" -> true
        else -> systemNight
    }

    fun background(dark: Boolean): Int = if (dark) DARK_BACKGROUND else LIGHT_BACKGROUND
}
