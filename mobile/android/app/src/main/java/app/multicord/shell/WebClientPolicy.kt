// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import android.Manifest
import android.webkit.PermissionRequest
import app.multicord.net.WebUrl

/**
 * What a web-client module's WebView may do (the service's own web app: Element, Stoat, Fluxer, Spacebar,
 * Nerimity, or any web app the user adds): the desktop's rules from src/main/sessionPolicy.ts.
 *
 * - Its own pages are those of the module's address: https on its host or a subdomain, or a sibling
 *   under the same parent (call.element.io for app.element.io), never across a shared hosting domain
 *   (isPlatformPage). The view navigates only there; any other link opens in the user's browser.
 * - Permissions: the desktop's allowlist ("notifications", "media", "display-capture",
 *   "clipboard-sanitized-write", "fullscreen") for its own pages only. In a WebView only "media" is a
 *   request (camera and microphone); WebView has no Notification or getDisplayMedia, and protected media
 *   (DRM ids) and MIDI are not on the list.
 */
object WebClientPolicy {
    /** Domains under which unrelated parties get their own subdomains: never one site (sessionPolicy.ts). */
    private val SHARED_PARENTS = setOf(
        "github.io", "gitlab.io", "pages.dev", "netlify.app", "vercel.app", "herokuapp.com", "web.app", "firebaseapp.com",
        "glitch.me", "onrender.com", "fly.dev", "co.uk", "org.uk", "com.au", "co.jp", "com.br",
    )

    /** Whether a page at `url` belongs to the web app at `moduleUrl` (isPlatformPage). */
    fun isOwnPage(url: String?, moduleUrl: String): Boolean {
        val page = url?.let { WebUrl.parse(it) } ?: return false
        if (page.protocol != "https:") return false
        val own = WebUrl.parse(moduleUrl)?.hostname ?: return false
        val host = page.hostname
        if (host == own || host.endsWith(".$own")) return true
        val labels = own.split(".")
        val parent = labels.drop(1).joinToString(".")
        return labels.size >= 3 && parent !in SHARED_PARENTS && host.endsWith(".$parent")
    }

    enum class Navigation { LOAD, BROWSER, DROP }

    /**
     * Where a top-level navigation goes: the app's own pages load in the view; other http(s) addresses
     * the user tapped open in the browser; anything else (other schemes, or a jump away the user did not
     * ask for) is dropped.
     */
    fun navigation(url: String, moduleUrl: String, userGesture: Boolean): Navigation {
        if (isOwnPage(url, moduleUrl)) return Navigation.LOAD
        val scheme = WebUrl.parse(url)?.protocol
        return if (userGesture && (scheme == "https:" || scheme == "http:")) Navigation.BROWSER else Navigation.DROP
    }

    /** The Android permission each grantable WebView resource needs. */
    val ANDROID_PERMISSIONS = mapOf(
        PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
        PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
    )

    /** The resources of a page's request that the allowlist grants: camera and microphone, for the app's own pages only. */
    fun grantable(resources: List<String>, origin: String?, moduleUrl: String): List<String> =
        if (!isOwnPage(origin, moduleUrl)) emptyList() else resources.filter { it in ANDROID_PERMISSIONS }
}
