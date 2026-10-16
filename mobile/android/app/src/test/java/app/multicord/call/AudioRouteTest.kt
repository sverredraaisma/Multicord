// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.call

import android.media.AudioDeviceInfo
import app.multicord.call.AudioRoute.BLUETOOTH
import app.multicord.call.AudioRoute.EARPIECE
import app.multicord.call.AudioRoute.SPEAKER
import app.multicord.call.AudioRoute.WIRED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioRouteTest {
    private val phone = setOf(EARPIECE, SPEAKER)

    @Test
    fun routesByTheirWireNamesOnly() {
        assertEquals(listOf("earpiece", "speaker", "wired", "bluetooth"), AudioRoute.entries.map { it.wire })
        assertEquals(SPEAKER, AudioRoute.of("speaker"))
        assertNull(AudioRoute.of("Speaker"))
        assertNull(AudioRoute.of("SPEAKER"))
        assertNull(AudioRoute.of(""))
        assertNull(AudioRoute.of(null))
    }

    @Test
    fun aVoiceCallPlaysAtTheEarAVideoCallAloudAHeadsetWins() {
        assertEquals(EARPIECE, AudioRoute.pick(phone, null, video = false))
        assertEquals(SPEAKER, AudioRoute.pick(phone, null, video = true))
        assertEquals(WIRED, AudioRoute.pick(phone + WIRED, null, video = true))
        assertEquals(BLUETOOTH, AudioRoute.pick(phone + WIRED + BLUETOOTH, null, video = false))
        // A tablet has no earpiece.
        assertEquals(SPEAKER, AudioRoute.pick(setOf(SPEAKER), null, video = false))
        assertNull(AudioRoute.pick(emptySet(), null, video = false))
    }

    @Test
    fun theUsersChoiceHoldsWhileItsRouteIsThere() {
        assertEquals(SPEAKER, AudioRoute.pick(phone + BLUETOOTH, SPEAKER, video = false))
        assertEquals(EARPIECE, AudioRoute.pick(phone, EARPIECE, video = true))
        // The headset went: back to the default.
        assertEquals(EARPIECE, AudioRoute.pick(phone, BLUETOOTH, video = false))
    }

    @Test
    fun reportsTheRouteInUseAndThoseAvailableInAFixedOrder() {
        assertEquals("""{"current":"bluetooth","available":["earpiece","speaker","bluetooth"]}""", AudioRoute.report(BLUETOOTH, setOf(BLUETOOTH, SPEAKER, EARPIECE)).toString())
        // The route in use is always among them.
        assertEquals("""{"current":"wired","available":["speaker","wired"]}""", AudioRoute.report(WIRED, setOf(SPEAKER)).toString())
    }

    @Test
    fun audioDevicesStandForTheirRoutes() {
        assertEquals(EARPIECE, CallAudio.routeOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE))
        assertEquals(SPEAKER, CallAudio.routeOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER))
        for (type in listOf(AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET)) assertEquals(WIRED, CallAudio.routeOf(type))
        for (type in listOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET)) assertEquals(BLUETOOTH, CallAudio.routeOf(type))
        // Music-only Bluetooth (A2DP), HDMI and the telephony line carry no call.
        for (type in listOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_TELEPHONY, AudioDeviceInfo.TYPE_BUILTIN_MIC)) assertNull(CallAudio.routeOf(type))
    }
}
