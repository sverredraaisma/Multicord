// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

import app.multicord.bridge.Limits
import java.io.IOException
import java.io.InputStream

/** An engine's HTTP request, validated (see Validators.isHttpRequest). A string body is sent as UTF-8. */
class HttpRequest(val url: String, val method: String, val headers: Map<String, String>, val body: Body?)

/** A request body: text or bytes, as the engine sent it. */
sealed class Body {
    class Text(val text: String) : Body()
    class Bytes(val bytes: ByteArray) : Body()
}

class HttpResponse(val status: Int, val headers: Map<String, String>, val body: ByteArray)

/** One hop of a request, as the network stack answers it. The bridge closes it. */
class TransportResponse(
    val status: Int,
    /** Names lowercase, in the order received; a name may repeat. */
    val headers: List<Pair<String, String>>,
    /** -1 when unknown. */
    val contentLength: Long,
    val body: InputStream,
) : AutoCloseable {
    override fun close() = body.close()
}

/** Sends one request without following redirects. Implementations must check what names resolve to (PublicDns). */
fun interface HttpTransport {
    @Throws(IOException::class)
    fun fetch(url: WebUrl, method: String, headers: Map<String, String>, body: Body?): TransportResponse
}

/**
 * Performs an engine's HTTP request, as performHttp in src/main/netPolicy.ts does: every URL, each redirect
 * included, is checked against the policy; redirects change the method as browsers do and stop after
 * [NetPolicy.MAX_REDIRECTS]; responses are capped at MAX_HTTP_BODY; cookies never pass either way.
 */
object HttpBridge {
    @Throws(IOException::class)
    fun perform(transport: HttpTransport, request: HttpRequest, policy: UrlPolicy): HttpResponse {
        val headers = NetPolicy.forwardedHeaders(request.headers)
        var url = WebUrl.parse(request.url) ?: throw IOException("Request blocked: not a valid URL")
        var method = request.method
        var body = request.body
        var hop = 0
        while (true) {
            NetPolicy.check(url, policy)?.let { throw IOException("Request blocked: ${it.message}") }
            transport.fetch(url, method, headers, body).use { response ->
                val location = response.headers.firstOrNull { it.first == "location" }?.second
                if (NetPolicy.isRedirect(response.status) && location != null) {
                    if (hop >= NetPolicy.MAX_REDIRECTS) throw IOException("Too many redirects")
                    url = WebUrl.parse(location, url) ?: throw IOException("Request blocked: not a valid URL")
                    val (next, keepsBody) = NetPolicy.afterRedirect(response.status, method)
                    method = next
                    if (!keepsBody) body = null
                    hop++
                    return@use
                }
                if (response.contentLength > Limits.MAX_HTTP_BODY) throw IOException("Response too large")
                val data = readCapped(response.body, Limits.MAX_HTTP_BODY)
                val out = LinkedHashMap<String, String>()
                for ((name, value) in response.headers) {
                    if (name == "set-cookie" || name == "set-cookie2") continue
                    // As the Fetch API's Headers joins a repeated header.
                    out[name] = out[name]?.let { "$it, $value" } ?: value
                }
                return HttpResponse(response.status, out, data)
            }
        }
    }

    /** Reads a body as it arrives and gives up as soon as it passes `limit`. */
    @Throws(IOException::class)
    fun readCapped(input: InputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            if (out.size() + n > limit) throw IOException("Response too large")
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }
}
