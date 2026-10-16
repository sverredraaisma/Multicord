// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.background

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BootReceiverTest {
    @Test
    fun startsOnlyWhenTheUserTurnedItOn() {
        assertTrue(BootReceiver.startsWithPhone("""{"general":{"launchAtLogin":true,"notifications":true}}"""))
        assertFalse(BootReceiver.startsWithPhone("""{"general":{"launchAtLogin":false}}"""))
        // Off by default: no settings file yet, or one that never set it.
        assertFalse(BootReceiver.startsWithPhone(null))
        assertFalse(BootReceiver.startsWithPhone("""{"general":{}}"""))
        assertFalse(BootReceiver.startsWithPhone("{}"))
    }

    @Test
    fun takesNothingButTheBooleanTrue() {
        assertFalse(BootReceiver.startsWithPhone("""{"general":{"launchAtLogin":"true"}}"""))
        assertFalse(BootReceiver.startsWithPhone("""{"general":{"launchAtLogin":1}}"""))
        assertFalse(BootReceiver.startsWithPhone("""{"general":true}"""))
        assertFalse(BootReceiver.startsWithPhone("""{"launchAtLogin":true}"""))
        assertFalse(BootReceiver.startsWithPhone("[true]"))
        assertFalse(BootReceiver.startsWithPhone("{"))
        assertFalse(BootReceiver.startsWithPhone(""))
    }
}
