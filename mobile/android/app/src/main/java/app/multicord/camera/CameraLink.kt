// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.camera

import android.content.Context
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * One view's USB camera: the page patch (usb-camera.js, src/mobile/usbCamera.ts) installed for the view's own
 * origin, and the frame channel (CameraPort) handed to each document the view loads on that origin, only while
 * the user has "USB camera in calls" on for the service. Turning it off closes the channel, and the page hears
 * there is no camera; until it is on the patch only passes everything through.
 */
class CameraLink(private val origin: String, private val camera: () -> UsbCamera) {
    private var enabled = false
    private var port: CameraPort? = null

    /** Installs the patch on a view before it loads anything. */
    fun install(context: Context, view: WebView) {
        // The feature asked here, where lint sees it; the app does not start without it (WebViewSupport).
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        val script = context.assets.open("web/mobile/usb-camera.js").bufferedReader().use { it.readText() }
        WebViewCompat.addDocumentStartJavaScript(view, script, setOf(origin))
    }

    /** A document finished loading in the view: it gets a channel of its own if the camera is on. */
    fun pageLoaded(view: WebView) {
        close()
        if (enabled) port = CameraPort.connect(view, origin, camera())
    }

    /** The user's setting for this service; `view` is the view's WebView now, if any. */
    fun setEnabled(on: Boolean, view: WebView?) {
        if (on == enabled) return
        enabled = on
        if (!on) close() else if (view != null) port = port ?: CameraPort.connect(view, origin, camera())
    }

    fun close() {
        port?.close()
        port = null
    }
}
