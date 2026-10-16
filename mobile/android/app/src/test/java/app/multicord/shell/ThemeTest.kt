// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTest {
    @Test
    fun aChosenThemeHoldsWhateverThePhoneIsSet() {
        assertTrue(Theme.isDark("dark", systemNight = false))
        assertFalse(Theme.isDark("light", systemNight = true))
    }

    @Test
    fun asTheSystemFollowsThePhonesDarkTheme() {
        assertTrue(Theme.isDark("system", systemNight = true))
        assertFalse(Theme.isDark("system", systemNight = false))
    }

    @Test
    fun theScreenBehindThePagesIsTheirBackground() {
        assertEquals(0xFF1E1F22.toInt(), Theme.background(dark = true))
        assertEquals(0xFFE3E5E8.toInt(), Theme.background(dark = false))
    }
}
