// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.background

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationTargetTest {
    @Test
    fun takesOnlyTheShapesTheShellPageGives() {
        assertEquals(NotificationTarget("matrix", "!room:x.org", "dm:1"), NotificationTarget.of("matrix", "!room:x.org", "dm:1"))
        assertEquals(NotificationTarget("tg-2", "42", null), NotificationTarget.of("tg-2", "42", null))
        assertNull(NotificationTarget.of("Matrix", "42", null))
        assertNull(NotificationTarget.of("../x", "42", null))
        assertNull(NotificationTarget.of("matrix", null, null))
        assertNull(NotificationTarget.of("matrix", "", null))
        assertNull(NotificationTarget.of("matrix", "k".repeat(201), null))
        assertNull(NotificationTarget.of("matrix", "42", ""))
        assertNull(NotificationTarget.of("matrix", "42", "k".repeat(201)))
    }
}
