// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.call

import android.content.pm.ServiceInfo
import android.webkit.PermissionRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallPolicyTest {
    private fun state(json: String) = Json.parseToJsonElement(json) as JsonObject

    private val view = "https://matrix.view.multicord.invalid"
    private val audio = PermissionRequest.RESOURCE_AUDIO_CAPTURE
    private val video = PermissionRequest.RESOURCE_VIDEO_CAPTURE

    @Test
    fun aCallIsAChatScreenWhoseVoiceSessionHasItsServerAndGrant() {
        val voice = """"channelName":"Lounge","guildName":"","url":"wss://sfu.example","token":"t","mute":false,"deaf":false,"stream":false"""
        assertEquals(Call("m", "Lounge", false), Call.of("m", state("""{"screen":"chat","voice":{$voice,"video":false}}""")))
        assertEquals(Call("m", "Lounge", true), Call.of("m", state("""{"screen":"chat","voice":{$voice,"video":true}}""")))
        // A string is not a flag.
        assertEquals(Call("m", "Lounge", false), Call.of("m", state("""{"screen":"chat","voice":{$voice,"video":"true"}}""")))
        assertEquals("a call", Call.of("m", state("""{"screen":"chat","voice":{"url":"wss://s","token":"t","channelName":" "}}"""))!!.channelName)
        assertEquals(100, Call.of("m", state("""{"screen":"chat","voice":{"url":"wss://s","token":"t","channelName":"${"x".repeat(300)}"}}"""))!!.channelName.length)
    }

    @Test
    fun noCallWithoutAConnectedVoiceSessionOnAChatScreen() {
        assertNull(Call.of("m", null))
        assertNull(Call.of("m", state("""{"screen":"chat","voice":null}""")))
        assertNull(Call.of("m", state("""{"screen":"chat"}""")))
        assertNull(Call.of("m", state("""{"screen":"login","voice":{"url":"wss://s","token":"t"}}""")))
        assertNull(Call.of("m", state("""{"screen":"chat","voice":{"channelName":"Lounge"}}"""))) // still connecting
        assertNull(Call.of("m", state("""{"screen":"chat","voice":{"url":"wss://s","token":""}}""")))
        assertNull(Call.of("m", state("""{"screen":"chat","voice":{"url":"wss://s","token":5}}""")))
        assertNull(Call.of("m", state("""{"screen":"chat","voice":[1]}""")))
    }

    @Test
    fun aPeerToPeerCallCountsOnceJoinedWithItsCallIdAndOwnId() {
        val p2p = """"p2p":{"callId":"c1","self":"42","peers":[],"iceServers":[],"relayOnly":true,"signals":[]}"""
        assertEquals(Call("n", "Ana", true), Call.of("n", state("""{"screen":"chat","voice":{"channelName":"Ana","video":true,$p2p}}""")))
        assertNull(Call.of("n", state("""{"screen":"chat","voice":{"channelName":"Ana","p2p":{"callId":"c 1","self":"42"}}}""")))
        assertNull(Call.of("n", state("""{"screen":"chat","voice":{"channelName":"Ana","p2p":{"callId":"c1","self":""}}}""")))
        assertNull(Call.of("n", state("""{"screen":"chat","voice":{"channelName":"Ana","p2p":{"callId":"c1"}}}""")))
        assertNull(Call.of("n", state("""{"screen":"chat","voice":{"channelName":"Ana","p2p":"c1"}}""")))
    }

    @Test
    fun theMicrophoneOnlyForTheViewsOwnCallAndTheCameraOnlyWithVideoOn() {
        val call = Call("matrix", "Lounge", false)
        assertEquals(listOf(audio), CallPolicy.grantable(listOf(audio, video), view, view, call))
        assertEquals(listOf(audio), CallPolicy.grantable(listOf(audio), "$view/", view, call))
        assertEquals(listOf(audio, video), CallPolicy.grantable(listOf(audio, video, audio), view, view, call.copy(video = true)))
        assertEquals(emptyList<String>(), CallPolicy.grantable(listOf(video), view, view, call))
        // No call, another origin, or anything else: nothing.
        assertEquals(emptyList<String>(), CallPolicy.grantable(listOf(audio, video), view, view, null))
        assertEquals(emptyList<String>(), CallPolicy.grantable(listOf(audio), "https://fluxer.view.multicord.invalid", view, call))
        assertEquals(emptyList<String>(), CallPolicy.grantable(listOf(audio), "https://evil.example", view, call))
        assertEquals(emptyList<String>(), CallPolicy.grantable(listOf(audio), null, view, call))
        assertEquals(emptyList<String>(), CallPolicy.grantable(listOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID, PermissionRequest.RESOURCE_MIDI_SYSEX), view, view, call.copy(video = true)))
    }

    @Test
    fun theServiceHoldsTheMicrophoneAndCameraOnlyInACallAndWithTheirPermission() {
        val special = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        val mic = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        val camera = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        val voiceCall = listOf(Call("m", "Lounge", false))
        val videoCall = listOf(Call("m", "Lounge", true))
        assertEquals(special, CallPolicy.serviceTypes(emptyList(), microphone = true, camera = true))
        assertEquals(special or mic, CallPolicy.serviceTypes(voiceCall, microphone = true, camera = true))
        assertEquals(special or mic or camera, CallPolicy.serviceTypes(videoCall, microphone = true, camera = true))
        assertEquals(special or mic, CallPolicy.serviceTypes(videoCall, microphone = true, camera = false))
        assertEquals(special, CallPolicy.serviceTypes(voiceCall, microphone = false, camera = true))
        assertEquals(special or camera, CallPolicy.serviceTypes(voiceCall + videoCall, microphone = false, camera = true))
    }
}
