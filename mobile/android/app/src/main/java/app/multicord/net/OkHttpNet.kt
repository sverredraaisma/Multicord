// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import java.io.IOException
import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Resolves names and refuses any that resolve to this device or a private network, as the desktop's
 * address guard does. It runs when the connection is made, on the very addresses connected to, so a
 * name cannot resolve to a public address for the check and a private one for the connection.
 */
class PublicDns(private val delegate: Dns = Dns.SYSTEM) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val addresses = delegate.lookup(hostname)
        if (addresses.any { !NetPolicy.isPublicAddress(it) }) throw UnknownHostException("$hostname resolves to a local or private address")
        return addresses
    }
}

/** The engines' HTTP client and socket client: one per app, sharing connections, never cookies or a cache. */
object EngineNet {
    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .dns(PublicDns())
            // Redirects are followed by HttpBridge, which checks each hop.
            .followRedirects(false)
            .followSslRedirects(false)
            // No proxy: the address check above must see where the connection goes.
            .proxy(Proxy.NO_PROXY)
            .connectTimeout(20, TimeUnit.SECONDS)
            // Long polls (Matrix's sync waits up to 30 s) must not time out.
            .readTimeout(5, TimeUnit.MINUTES)
            .writeTimeout(2, TimeUnit.MINUTES)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }

    /** OkHttp's form of a checked URL; null unless it names the very host the policy judged. */
    fun toHttpUrl(url: WebUrl): HttpUrl? {
        val scheme = when (url.protocol) {
            "https:", "wss:" -> "https:"
            "http:", "ws:" -> "http:"
            else -> return null
        }
        val href = url.href.removePrefix(url.protocol).let { scheme + it }.substringBefore('#')
        val parsed = href.toHttpUrlOrNull() ?: return null
        val host = if (url.hostname.startsWith("[")) parsed.host.let { WebUrl.parseHost("[$it]") } else parsed.host
        return if (host == url.hostname) parsed else null
    }
}

/** The HTTP bridge's network stack: OkHttp through [EngineNet]. */
class OkHttpTransport(private val client: OkHttpClient = EngineNet.client) : HttpTransport {
    override fun fetch(url: WebUrl, method: String, headers: Map<String, String>, body: Body?): TransportResponse {
        val httpUrl = EngineNet.toHttpUrl(url) ?: throw IOException("Request blocked: not a valid URL")
        val builder = Headers.Builder()
        try {
            for ((name, value) in headers) {
                // OkHttp asks for and unpacks compressed bodies itself, as a browser does.
                if (name.equals("accept-encoding", ignoreCase = true)) continue
                builder.add(name, value)
            }
        } catch (error: IllegalArgumentException) {
            throw IOException("Invalid request header: ${error.message}")
        }
        val built = builder.build()
        val contentType = built["Content-Type"]
        val requestBody = when (body) {
            null -> if (method == "POST" || method == "PUT" || method == "PATCH") ByteArray(0).toRequestBody(null) else null
            is Body.Text -> body.text.toRequestBody((contentType ?: "text/plain;charset=UTF-8").toMediaTypeOrNull())
            is Body.Bytes -> body.bytes.toRequestBody(contentType?.toMediaTypeOrNull())
        }
        if (requestBody != null && (method == "GET" || method == "HEAD")) throw IOException("A $method request cannot have a body")
        val request = Request.Builder().url(httpUrl).headers(built).method(method, requestBody).build()
        val response = client.newCall(request).execute()
        val list = ArrayList<Pair<String, String>>()
        for (i in 0 until response.headers.size) list.add(response.headers.name(i).lowercase() to response.headers.value(i))
        val responseBody = response.body!!
        return TransportResponse(response.code, list, responseBody.contentLength(), responseBody.byteStream())
    }
}
