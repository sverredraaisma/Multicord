// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.camera

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UvcNativeTest {
    @Test
    fun libuvcErrorCodesAreErrors() {
        for (code in listOf(0L, -1L, -6L, -51L, -99L)) assertTrue("$code", UvcNative.isError(code))
    }

    @Test
    fun taggedPointersAreHandles() {
        // Android's heap pointers on arm64 carry a tag in the top byte, which makes them negative as a Long.
        assertFalse(UvcNative.isError(0xb400007a1c2d3e40uL.toLong()))
        assertFalse(UvcNative.isError(-100L))
        assertFalse(UvcNative.isError(0x7a1c2d3e40L))
    }
}
