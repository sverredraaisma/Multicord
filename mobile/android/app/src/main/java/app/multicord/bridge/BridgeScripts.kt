// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.bridge

import android.content.Context
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Installs a page's bridge: its API script (engine.js, shell.js) in the page's own world, and the relay
 * (relay.js) with the native message listener, both restricted to the page's origin. Where the WebView
 * supports JS_INJECTION_IN_FRAME_AND_WORLD, the relay and the listener live in an isolated world of their
 * own: the page's scripts never hold the listener object, and messages can come only from that world.
 * Elsewhere everything runs in the page's world, as before.
 */
object BridgeScripts {
    /** The isolated world's name; a WebView keeps one per name. */
    private const val WORLD = "multicord-bridge"

    /** Whether this WebView can put the relay in an isolated world. */
    val isolatedWorld: Boolean get() = WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD)

    /**
     * Installs the bridge for `origins` on `view` before it loads anything. `listenerName` is the listener's
     * name in its world; `channel` names the events the API and the relay exchange (it must match the API
     * script's CHANNEL). Returns which world the relay runs in, for the log.
     */
    fun install(
        context: Context,
        view: WebView,
        listenerName: String,
        channel: String,
        apiAsset: String,
        origins: Set<String>,
        listener: WebViewCompat.WebMessageListener,
    ): String {
        val relay = asset(context, "bridge/relay.js").replace("__LISTENER__", listenerName).replace("__CHANNEL__", channel)
        val world = installRelay(view, listenerName, relay, origins, listener)
        WebViewCompat.addDocumentStartJavaScript(view, asset(context, apiAsset), origins)
        return world
    }

    /**
     * Installs a relay script and the native message listener it posts to, for `origins`, in the isolated world
     * where the WebView has one and in the page's world otherwise; returns which, for the log. The relay is any
     * document-start script that finds the listener as `window.<listenerName>` (relay.js, or the Discord view's).
     */
    fun installRelay(view: WebView, listenerName: String, relay: String, origins: Set<String>, listener: WebViewCompat.WebMessageListener): String {
        // The feature asked here, where lint sees it (isolatedWorld asks the same).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD)) {
            val world = WebViewCompat.getExecutionWorld(view, WORLD)
            WebViewCompat.addWebMessageListener(view, listenerName, origins, world, listener)
            WebViewCompat.addJavaScriptOnEvent(view, relay, WebViewCompat.INJECTION_EVENT_DOCUMENT_START, origins, world)
            return "isolated world"
        }
        WebViewCompat.addWebMessageListener(view, listenerName, origins, listener)
        WebViewCompat.addDocumentStartJavaScript(view, relay, origins)
        return "main world"
    }

    private fun asset(context: Context, name: String) = context.assets.open(name).bufferedReader().use { it.readText() }
}
