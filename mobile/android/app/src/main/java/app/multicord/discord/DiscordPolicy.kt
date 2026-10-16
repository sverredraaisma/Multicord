// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.discord

import android.Manifest
import android.webkit.PermissionRequest
import app.multicord.net.WebUrl
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What the Discord view may do: where it navigates, which origin its scripts and listener serve, what it is
 * granted, and the user agent it presents.
 *
 * - Its scripts and its message listener exist only on Discord's own origin, https://discord.com, the one its
 *   address loads (platforms' Discord entry is fixed to https://discord.com/app).
 * - It navigates only on Discord's pages (https on discord.com or a subdomain, and discord.gg's invite links,
 *   which lead there); other addresses the user tapped open in the browser, anything else is dropped. Captcha
 *   and other frames inside the page are not navigations of the view and are left alone.
 * - Camera and microphone go to https://discord.com only, once Android's permission is held (asked then), as
 *   on the desktop, where Discord's view gets them from its session's permission handler. Nothing else.
 */
object DiscordPolicy {
    /** Discord's own origin: scripts, the listener and permissions are for it alone. */
    const val ORIGIN = "https://discord.com"

    /** Hosts the view loads besides discord.com and its subdomains: invite links lead to discord.com. */
    private val INVITE_HOSTS = setOf("discord.gg")

    enum class Navigation { LOAD, BROWSER, DROP }

    /** Where a top-level navigation goes: Discord's pages load; other http(s) links the user tapped open in the browser. */
    fun navigation(url: String, userGesture: Boolean): Navigation {
        val parsed = WebUrl.parse(url) ?: return Navigation.DROP
        if (DiscordValidators.isDiscordPage(url) || (parsed.protocol == "https:" && parsed.hostname in INVITE_HOSTS)) return Navigation.LOAD
        return if (userGesture && (parsed.protocol == "https:" || parsed.protocol == "http:")) Navigation.BROWSER else Navigation.DROP
    }

    /** The Android permission each grantable WebView resource needs. */
    val ANDROID_PERMISSIONS = mapOf(
        PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
        PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA,
    )

    /** The resources of a page's request that may be granted (once Android's permission is held): camera and microphone, for Discord's own origin. */
    fun grantable(resources: List<String>, origin: String?): List<String> =
        if (origin?.trimEnd('/') != ORIGIN) emptyList() else resources.filter { it in ANDROID_PERMISSIONS }.distinct()

    /**
     * A desktop Chrome user agent on Linux with the WebView's own Chrome version, so Discord serves the web app
     * a computer's browser gets (docs/mobile.md, section 3; checked on a phone in spike 0.1). `webView` is the
     * WebView's own user agent, from which only the Chrome major version is taken.
     */
    fun desktopUserAgent(webView: String): String {
        val major = Regex("Chrome/([0-9]+)").find(webView)?.groupValues?.get(1) ?: "140"
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"
    }

    /** The desktop site setting (the module's DESKTOP_SITE), on unless the shell page says otherwise. */
    fun desktopSite(settings: JsonObject?): Boolean = (settings?.get("desktopSite") as? JsonPrimitive)?.takeIf { !it.isString }?.content != "false"
}
