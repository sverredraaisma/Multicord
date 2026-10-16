// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.camera

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The USB camera's frame channel to one page (docs/mobile.md, section 4.2, step 3): a MessageChannel whose one
 * port stays here and whose other is posted to the page's main frame, only if it is on the page's own origin
 * (postWebMessage's target origin). No local server, nothing another app could connect to. The page hears the
 * camera's status as JSON text (CameraFormats.statusMessage), and gets JPEGs as ArrayBuffers only while it has a
 * USB track open ("want"; FrameGate's caps: size, form, at most two waiting). Anything else it says is ignored.
 * The page's patch is src/mobile/usbCamera.ts.
 */
class CameraPort private constructor(private val camera: UsbCamera, private val port: WebMessagePortCompat) : UsbCamera.Sink {
    private val main = Handler(Looper.getMainLooper())
    private val gate = FrameGate()
    @Volatile private var closed = false

    override val wanted: Boolean get() = gate.wanted && !closed

    override fun onStatus(status: CameraStatus?) {
        if (!closed) port.postMessage(WebMessageCompat(CameraFormats.statusMessage(status)))
    }

    override fun onFrame(jpeg: ByteArray) {
        if (closed || !gate.admit(jpeg)) return
        main.post {
            gate.posted()
            if (!closed) port.postMessage(WebMessageCompat(jpeg))
        }
    }

    /** The page went, or the setting was turned off: the channel closes and the camera may stop. */
    fun close() {
        if (closed) return
        // The page ends its USB tracks and stops listing the camera.
        runCatching { port.postMessage(WebMessageCompat(CameraFormats.statusMessage(null))) }
        closed = true
        camera.removeSink(this)
        port.close()
    }

    companion object {
        private const val TAG = "Multicord"
        /** What the handover carries (src/mobile/usbCamera.ts, USB_HELLO). */
        const val HELLO = "multicord-usb-camera"

        /**
         * Hands the page in `webView`'s main frame a channel, if that frame is on `origin` and the WebView can
         * send ArrayBuffers over message ports; null otherwise. Call once per document (the page's patch takes
         * the latest).
         */
        fun connect(webView: WebView, origin: String, camera: UsbCamera): CameraPort? {
            val ok = WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_CLOSE)
            if (!ok) {
                Log.i(TAG, "[camera] this WebView cannot send frames over message ports: no USB camera in pages")
                return null
            }
            val (mine, theirs) = WebViewCompat.createWebMessageChannel(webView)
            val channel = CameraPort(camera, mine)
            mine.setWebMessageCallback(Handler(Looper.getMainLooper()), object : WebMessagePortCompat.WebMessageCallbackCompat() {
                override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                    val text = if (message?.type == WebMessageCompat.TYPE_STRING) message.data else null
                    if (channel.gate.onPageMessage(text)) camera.demand()
                }
            })
            WebViewCompat.postWebMessage(webView, WebMessageCompat(HELLO, arrayOf(theirs)), Uri.parse(origin))
            camera.addSink(channel)
            return channel
        }
    }
}
