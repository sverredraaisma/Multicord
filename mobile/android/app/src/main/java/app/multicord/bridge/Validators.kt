// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.bridge

import app.multicord.net.WebUrl
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The desktop's validators, ported to Kotlin so the native side checks every message before it acts on it
 * or passes it on: what engines and views send (src/shared/engine.ts: isEngineRequest, isHttpRequest,
 * isEngineEvent; src/shared/native.ts: isNativeAction; src/shared/settings.ts: isServiceSettingStatus) and
 * the engine commands the shell page sends (isEngineCommand, isServiceSettingValues). Messages arrive as
 * JSON (see Wire), with byte arrays in a [Wire.BYTES] envelope.
 *
 * They mirror the TypeScript line by line and are tested with the same cases (ValidatorsTest, with the
 * shared fixture tests/fixtures/engine-validator-cases.json).
 */
object Validators {
    private val HOST_PATTERN = Regex("^(\\*\\.)?[a-z0-9]([a-z0-9-]{0,62})(\\.[a-z0-9]([a-z0-9-]{0,62}))+$")
    private val SOCKET_ID = Regex("^[a-z0-9-]{1,64}$")
    private val PROTOCOL_TOKEN = Regex("^[!#\$%&'*+.^_`|~0-9A-Za-z-]+$")
    private val METHODS = setOf("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")
    private val COLOR = Regex("^#[0-9a-fA-F]{6}$")
    private val DATA_IMAGE = Regex("^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$")
    private val HEADER_NAME = Regex("^[A-Za-z0-9-]{1,64}$")
    private val FIELD_KEY = Regex("^[a-z][A-Za-z0-9]{0,31}$")

    // Reading JSON as JavaScript's typeof sees it ------------------------------------------------------------

    internal fun JsonElement?.record(): JsonObject? = this as? JsonObject
    internal fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
    internal fun JsonElement?.boolean(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    internal fun JsonElement?.number(): Double? {
        val p = this as? JsonPrimitive ?: return null
        if (p.isString || p is JsonNull || p.content == "true" || p.content == "false") return null
        return p.content.toDoubleOrNull()
    }

    internal fun isText(value: JsonElement?, max: Int, min: Int = 0): Boolean =
        value.string()?.let { it.length in min..max } == true

    internal fun isBoolean(value: JsonElement?): Boolean = value.boolean() != null
    internal fun isInteger(value: JsonElement?): Boolean = value.number()?.let { it.isFinite() && it == Math.floor(it) } == true
    internal fun isCount(value: JsonElement?): Boolean = isInteger(value) && value.number()!! >= 0
    private fun optional(value: JsonElement?, check: (JsonElement?) -> Boolean): Boolean = value == null || check(value)

    /** A Uint8Array as Wire carries it, within `max` bytes. */
    fun isBytes(value: JsonElement?, max: Int): Boolean {
        val length = Wire.bytesLength(value) ?: return false
        return length <= max
    }

    /** Whether `value` is a string `new URL()` reads as https. */
    fun isHttpsUrl(value: JsonElement?): Boolean = value.string()?.let { WebUrl.parse(it)?.protocol == "https:" } == true

    // src/shared/engine.ts -----------------------------------------------------------------------------------

    /** An icon or avatar: an https URL, or a small inline raster image. */
    fun isImageUrl(value: JsonElement?): Boolean {
        val s = value.string() ?: return false
        if (s.startsWith("data:")) return s.length <= Limits.MAX_DATA_IMAGE && DATA_IMAGE.matches(s)
        return s.length <= 2000 && isHttpsUrl(value)
    }

    private fun isServer(value: JsonElement?, depth: Int = 0): Boolean {
        val v = value.record() ?: return false
        val kind = v["kind"]
        val children = v["children"]
        val color = v["color"]
        val previews = v["previewIconUrls"]
        return isText(v["key"], Limits.MAX_KEY, 1) &&
            isText(v["name"], Limits.MAX_TEXT) &&
            optional(v["iconUrl"], ::isImageUrl) &&
            isBoolean(v["unread"]) &&
            isCount(v["mentions"]) &&
            (kind == null || kind.string() == "server" || kind.string() == "group") &&
            (children == null || (depth == 0 && kind.string() == "group" && children is JsonArray && children.size <= Limits.MAX_SERVERS &&
                children.all { isServer(it, 1) && it.record()!!["kind"].string() != "group" })) &&
            optional(v["expanded"], ::isBoolean) &&
            (color == null || color.string()?.let(COLOR::matches) == true) &&
            (previews == null || (previews is JsonArray && previews.size <= 4 && previews.all(::isImageUrl)))
    }

    private fun isDirect(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return isText(v["key"], Limits.MAX_KEY, 1) &&
            isText(v["title"], Limits.MAX_TEXT) &&
            optional(v["avatarUrl"], ::isImageUrl) &&
            isCount(v["lastActivity"]) &&
            optional(v["preview"]) { isText(it, Limits.MAX_BODY_TEXT) } &&
            isBoolean(v["unread"]) &&
            isCount(v["mentions"])
    }

    private fun isAccount(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        val state = v["state"].string()
        return (state == "signed-in" || state == "signed-out" || state == "unknown") && optional(v["name"]) { isText(it, Limits.MAX_TEXT) }
    }

    fun isEngineEvent(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["type"].string()) {
            "servers" -> (v["servers"] as? JsonArray)?.let { it.size <= Limits.MAX_SERVERS && it.all { s -> isServer(s) } } == true
            "directs" -> (v["directs"] as? JsonArray)?.let { it.size <= Limits.MAX_DIRECTS && it.all(::isDirect) } == true
            "notification" -> v["notification"].record()?.let { n ->
                isText(n["title"], Limits.MAX_TEXT) &&
                    isText(n["body"], Limits.MAX_BODY_TEXT) &&
                    isText(n["target"], Limits.MAX_KEY, 1) &&
                    optional(n["railKey"]) { isText(it, Limits.MAX_KEY, 1) } &&
                    optional(n["inView"], ::isBoolean)
            } == true
            "call" -> v["call"].record()?.let { c ->
                isText(c["conversationKey"], Limits.MAX_KEY, 1) && isText(c["from"], Limits.MAX_TEXT) && isBoolean(c["video"])
            } == true
            "account" -> isAccount(v["account"])
            "homeBadge" -> v["badge"].record()?.let { isBoolean(it["unread"]) && isCount(it["mentions"]) } == true
            "settingsStatus" -> isServiceSettingStatus(v["status"])
            "health" -> (v["checks"] as? JsonArray)?.let { checks ->
                checks.size <= Limits.MAX_HEALTH_CHECKS && checks.all { c ->
                    val r = c.record()
                    r != null && isText(r["name"], Limits.MAX_HEALTH_NAME, 1) && isBoolean(r["ok"]) && optional(r["detail"]) { isText(it, Limits.MAX_HEALTH_DETAIL) }
                }
            } == true
            else -> false
        }
    }

    private fun isHeaders(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return v.size <= Limits.MAX_HEADERS && v.all { (name, header) -> HEADER_NAME.matches(name) && isText(header, 8192) }
    }

    fun isHttpRequest(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        val body = v["body"]
        return isText(v["url"], 8192, 1) &&
            v["method"].string() in METHODS &&
            isHeaders(v["headers"]) &&
            (body == null || isText(body, Limits.MAX_HTTP_BODY) || isBytes(body, Limits.MAX_HTTP_BODY))
    }

    fun isEngineRequest(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["type"].string()) {
            "info", "pickFiles" -> true
            "secretLoad", "secretDelete" -> isText(v["key"], Limits.MAX_KEY, 1)
            "secretSave" -> isText(v["key"], Limits.MAX_KEY, 1) && isText(v["value"], Limits.MAX_SECRET)
            "http" -> isHttpRequest(v["request"])
            "ssoSignIn" -> isText(v["url"], 2048, 1)
            "lockHosts" -> (v["hosts"] as? JsonArray)?.let { hosts ->
                hosts.size in 1..Limits.MAX_LOCKED_HOSTS && hosts.all { h -> h.string()?.let { it.length <= 253 && HOST_PATTERN.matches(it) } == true }
            } == true
            "readFile" -> isText(v["handle"], 64, 1) && isCount(v["start"]) && isCount(v["end"]) &&
                v["end"].number()!! >= v["start"].number()!! && v["end"].number()!! - v["start"].number()!! <= Limits.MAX_READ
            "socketOpen" -> isText(v["url"], 8192, 1) && optional(v["protocols"], ::isSocketProtocols)
            "socketSend" -> isSocketId(v["id"]) && isFrame(v["data"])
            "socketClose" -> isSocketId(v["id"]) &&
                optional(v["code"]) { code -> code.number()?.let { it == 1000.0 || (isInteger(code) && it >= 3000 && it <= 4999) } == true } &&
                optional(v["reason"]) { r -> r.string()?.let { utf8Length(it) <= Limits.MAX_CLOSE_REASON } == true }
            else -> false
        }
    }

    private fun isSocketId(value: JsonElement?): Boolean = value.string()?.let(SOCKET_ID::matches) == true

    /** A frame on a bridged socket: text or bytes, within MAX_SOCKET_FRAME. */
    fun isFrame(value: JsonElement?): Boolean = isText(value, Limits.MAX_SOCKET_FRAME) || isBytes(value, Limits.MAX_SOCKET_FRAME)

    fun isSocketProtocol(value: JsonElement?): Boolean = isText(value, Limits.MAX_SOCKET_PROTOCOL, 1) && PROTOCOL_TOKEN.matches(value.string()!!)

    fun isSocketProtocols(value: JsonElement?): Boolean {
        val list = value as? JsonArray ?: return false
        return list.size in 1..Limits.MAX_SOCKET_PROTOCOLS && list.all(::isSocketProtocol) && list.map { it.string() }.toSet().size == list.size
    }

    /** Bytes as TextEncoder would write the string (a lone surrogate as U+FFFD). */
    fun utf8Length(s: String): Int {
        var n = 0
        var i = 0
        while (i < s.length) {
            val c = s[i]
            n += when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                    i++
                    4
                }
                else -> 3
            }
            i++
        }
        return n
    }

    /** A command for an engine, as the shell page sends it (isEngineCommand). */
    fun isEngineCommand(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["type"].string()) {
            "openHome", "signOut" -> true
            "openServer", "openConversation", "toggleGroup" -> isText(v["key"], Limits.MAX_KEY, 1)
            "visible" -> isBoolean(v["visible"])
            "settings" -> isServiceSettingValues(v["values"])
            "settingAction" -> v["key"].string()?.let(FIELD_KEY::matches) == true
            else -> false
        }
    }

    // src/shared/settings.ts ---------------------------------------------------------------------------------

    private val CHOICE_VALUE = Regex("^[a-z0-9-]{1,32}$")

    /** Settings values as a command carries them: known shapes only (isServiceSettingValues). */
    fun isServiceSettingValues(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return v.size <= Limits.MAX_SERVICE_FIELDS && v.all { (key, item) ->
            FIELD_KEY.matches(key) && (isBoolean(item) || item.string()?.let(CHOICE_VALUE::matches) == true)
        }
    }

    fun isServiceSettingStatus(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return v.size <= Limits.MAX_SERVICE_FIELDS && v.all { (key, status) ->
            val s = status.record()
            FIELD_KEY.matches(key) && s != null &&
                s.keys.all { it == "text" || it == "disabled" } &&
                optional(s["text"]) { isText(it, Limits.MAX_STATUS_TEXT) } &&
                optional(s["disabled"], ::isBoolean)
        }
    }

    // src/shared/native.ts -----------------------------------------------------------------------------------

    const val MAX_MESSAGE_LENGTH = 4000
    const val MAX_ATTACHMENTS = 10
    const val MAX_PROMPT_FIELDS = 8
    const val MAX_POLL_OPTIONS = 20
    const val MIN_NEW_POLL_ANSWERS = 2
    const val MAX_NEW_POLL_ANSWERS = 10
    const val MAX_NEW_POLL_QUESTION = 255
    const val MAX_NEW_POLL_ANSWER = 100
    const val MAX_SEARCH_QUERY = 200
    const val MAX_GIF_QUERY = 100
    const val MAX_MEMBER_OFFSET = 100_000
    const val MAX_JOIN_ADDRESS = 255
    const val MAX_SDP = 32768
    const val MAX_ICE_CANDIDATE = 1024

    private val ID = Regex("^([0-9]{1,20}|[0-9A-HJKMNP-TV-Z]{26})$")
    private val PROMPT_ID = Regex("^[a-z][a-z0-9-]{0,31}$")
    private val PROMPT_NAME = Regex("^[A-Za-z][A-Za-z0-9]{0,31}$")
    private val FOLDER_ID = Regex("^[A-Za-z0-9_-]{1,32}$")
    private val POLL_OPTION_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val MEDIA_ID = Regex("^[A-Za-z0-9:._@!+=/-]{1,200}$")
    private val MEDIA_KEY = Regex("^[A-Za-z0-9:._-]{1,200}$")
    private val MEMBER_ID = Regex("^[A-Za-z0-9@:._=+/-]{1,255}$")
    private val SDP_MID = Regex("^[A-Za-z0-9_-]{1,32}$")

    private fun id(value: JsonElement?): Boolean = value.string()?.let(ID::matches) == true
    private fun promptId(value: JsonElement?): Boolean = value.string()?.let(PROMPT_ID::matches) == true

    /** What JavaScript's String.prototype.trim removes: its whitespace and line terminators. */
    internal fun jsTrim(s: String): String = s.trim { isJsSpace(it.code) }

    /** JavaScript's \s: Unicode space separators, the ASCII whitespace controls, line terminators and BOM. */
    private fun isJsSpace(code: Int): Boolean =
        code in 9..13 || code == 0x20 || code == 0x2028 || code == 0x2029 || code == 0xfeff ||
            Character.getType(code) == Character.SPACE_SEPARATOR.toInt()

    /**
     * /^[^\s\p{Cc}\p{Cf}]+$/u: one word of printable characters. Checked per code point, as Android's regex
     * engine and the JVM's read \s differently.
     */
    private fun isOneWord(s: String): Boolean = s.isNotEmpty() && s.codePoints().noneMatch { code ->
        val type = Character.getType(code)
        isJsSpace(code) || type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt()
    }

    private fun isPromptValues(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return v.size <= MAX_PROMPT_FIELDS && v.all { (name, text) -> PROMPT_NAME.matches(name) && isText(text, 1024) }
    }

    private fun content(value: JsonElement?): Boolean = isText(value, MAX_MESSAGE_LENGTH, 1) && jsTrim(value.string()!!) != ""
    private fun pollText(value: JsonElement?, max: Int): Boolean =
        isText(value, max, 1) && jsTrim(value.string()!!) != "" && value.string()!!.codePoints().noneMatch { Character.getType(it) == Character.CONTROL.toInt() }

    private fun isPollAnswers(value: JsonElement?): Boolean {
        val list = value as? JsonArray ?: return false
        if (list.size < MIN_NEW_POLL_ANSWERS || list.size > MAX_NEW_POLL_ANSWERS) return false
        return list.all { pollText(it, MAX_NEW_POLL_ANSWER) } && list.map { jsTrim(it.string()!!) }.toSet().size == list.size
    }

    /** An ICE candidate in a signal: its line (no line breaks), and where given its m-line index (0 to 255) and mid, each may be null. */
    private fun isIceCandidate(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        if (!v.keys.all { it in setOf("candidate", "sdpMLineIndex", "sdpMid") }) return false
        val line = v["candidate"].string() ?: return false
        if (line.length > MAX_ICE_CANDIDATE || line.contains('\r') || line.contains('\n')) return false
        val index = v["sdpMLineIndex"]
        if (index != null && index !is JsonNull && !(isInteger(index) && index.number()!! >= 0 && index.number()!! <= 255)) return false
        val mid = v["sdpMid"]
        return mid == null || mid is JsonNull || mid.string()?.let(SDP_MID::matches) == true
    }

    /**
     * A WebRTC signal a view sends to a peer of its peer-to-peer call (isVoiceSignal), in simple-peer's forms
     * with nothing beyond their fields: a session description, an ICE candidate, a renegotiation or a
     * transceiver request.
     */
    fun isVoiceSignal(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["type"].string()) {
            "offer", "answer" -> v.keys == setOf("type", "sdp") && isText(v["sdp"], MAX_SDP, 1)
            "candidate" -> v.keys == setOf("type", "candidate") && isIceCandidate(v["candidate"])
            "renegotiate" -> v.keys == setOf("type", "renegotiate") && v["renegotiate"].boolean() == true
            "transceiverRequest" -> v.keys == setOf("type", "transceiverRequest") && v["transceiverRequest"].record()?.let { request ->
                request.keys == setOf("kind") && request["kind"].string().let { it == "audio" || it == "video" }
            } == true
            else -> false
        }
    }

    private val MESH_SOURCES = listOf("microphone", "camera", "screen_share", "screen_share_audio")
    private val MESH_SID = Regex("^[A-Za-z0-9_.:-]{1,300}$")
    private val ICE_UFRAG = Regex("^[A-Za-z0-9+/]{1,256}$")

    /** A generation or version counter of a Fluxer call's signal: a safe integer, not negative. */
    private fun isCounter(value: JsonElement?): Boolean = isCount(value) && value.number()!! <= 9007199254740991.0

    private fun isMeshCandidate(value: JsonElement?): Boolean {
        if (value is JsonNull) return true
        val v = value.record() ?: return false
        val ufrag = v["usernameFragment"]
        if (ufrag != null && ufrag !is JsonNull && ufrag.string()?.let(ICE_UFRAG::matches) != true) return false
        return isIceCandidate(JsonObject(v - "usernameFragment"))
    }

    private fun isMeshTrack(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        if (!v.keys.all { it in setOf("src", "sid", "m", "w", "h") }) return false
        val dimension = { d: JsonElement? -> d == null || (d.number()?.let { it.isFinite() && it >= 0 && it <= 65535 } == true) }
        return v["src"].string() in MESH_SOURCES && v["sid"].string()?.let(MESH_SID::matches) == true && isBoolean(v["m"]) && dimension(v["w"]) && dimension(v["h"])
    }

    /**
     * A signal a view sends to a peer of a Fluxer peer-to-peer call (isMeshSignal), in the forms Fluxer's own
     * client sends, with nothing beyond their fields: a session description or ICE candidate of one
     * generation, a request for an offer, the tracks the view sends (one per source) or those it wants.
     */
    fun isMeshSignal(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["t"].string()) {
            "offer", "answer" -> v.keys == setOf("t", "g", "sdp") && isCounter(v["g"]) && isText(v["sdp"], MAX_SDP, 1)
            "ice" -> v.keys == setOf("t", "g", "c") && isCounter(v["g"]) && isMeshCandidate(v["c"])
            "need-offer" -> (v.keys == setOf("t", "g") || (v.keys == setOf("t", "g", "restart") && v["restart"].boolean() == true)) && isCounter(v["g"])
            "tracks" -> v.keys == setOf("t", "v", "tracks") && isCounter(v["v"]) && (v["tracks"] as? JsonArray)?.let { tracks ->
                tracks.size <= MESH_SOURCES.size && tracks.all(::isMeshTrack) && tracks.map { it.record()!!["src"].string() }.toSet().size == tracks.size
            } == true
            "want" -> v.keys == setOf("t", "v", "sids") && isCounter(v["v"]) && (v["sids"] as? JsonArray)?.let { sids ->
                sids.size <= MESH_SOURCES.size && sids.all { it.string()?.let(MESH_SID::matches) == true }
            } == true
            else -> false
        }
    }

    /** A user action from a module's own view; `sendFile` is the shell's alone and never accepted from a view. */
    fun isNativeAction(value: JsonElement?): Boolean {
        val v = value.record() ?: return false
        return when (v["type"].string()) {
            "ready", "cancelMfa", "loadOlder", "typing", "attach", "leaveVoice", "logout" -> true
            "login" -> isText(v["identity"], 320, 1) && isText(v["password"], 1024, 1)
            "mfa" -> isText(v["code"], 32, 1)
            "prompt" -> promptId(v["id"]) && isPromptValues(v["values"])
            "cancelPrompt" -> promptId(v["id"])
            "select" -> id(v["channelId"])
            // Empty text is allowed: a message may be attachments only.
            "send" -> isText(v["content"], MAX_MESSAGE_LENGTH) && optional(v["replyTo"], ::id) && optional(v["thread"], ::id)
            "thread" -> optional(v["rootId"], ::id)
            "joinVoice" -> id(v["channelId"])
            "mute" -> id(v["channelId"]) && isBoolean(v["mute"])
            "archive" -> id(v["channelId"]) && isBoolean(v["archive"])
            "folder" -> v["id"].string()?.let(FOLDER_ID::matches) == true
            "pins" -> isBoolean(v["open"])
            "vote" -> id(v["messageId"]) && (v["options"] as? JsonArray)?.let { options ->
                options.size <= MAX_POLL_OPTIONS && options.all { o -> o.string()?.let(POLL_OPTION_ID::matches) == true } &&
                    options.map { it.string() }.toSet().size == options.size
            } == true
            "createPoll" -> pollText(v["question"], MAX_NEW_POLL_QUESTION) && isPollAnswers(v["answers"]) && isBoolean(v["multiple"]) &&
                optional(v["anonymous"], ::isBoolean)
            "endPoll" -> id(v["messageId"])
            "forward" -> id(v["messageId"]) && id(v["channelId"])
            "join", "decline", "declineCall" -> id(v["channelId"])
            // One word of printable characters: the module reads it as an address of its own kind.
            "joinAddress" -> v["address"].string()?.let { it.length <= MAX_JOIN_ADDRESS && isOneWord(it) } == true
            "search" -> isText(v["query"], MAX_SEARCH_QUERY)
            "pin" -> id(v["messageId"]) && isBoolean(v["pin"])
            "voiceState" -> listOf("mute", "deaf", "video", "stream").all { isBoolean(v[it]) }
            "voiceError" -> isText(v["message"], 500, 1)
            "voiceNotice" -> isText(v["message"], 500, 1) && optional(v["off"]) { it.string() == "video" || it.string() == "stream" }
            "voiceSignal" -> v["to"].string()?.let(MEMBER_ID::matches) == true && (isVoiceSignal(v["signal"]) || isMeshSignal(v["signal"]))
            "loadMedia" -> v["key"].string()?.let(MEDIA_KEY::matches) == true
            "sendSticker" -> v["stickerId"].string()?.let(MEDIA_ID::matches) == true && optional(v["replyTo"], ::id)
            "searchGifs" -> isText(v["query"], MAX_GIF_QUERY)
            "picker", "members" -> isBoolean(v["open"])
            "loadMembers" -> isInteger(v["offset"]) && v["offset"].number()!! >= 0 && v["offset"].number()!! <= MAX_MEMBER_OFFSET
            "profile" -> v["id"].string()?.let(MEMBER_ID::matches) == true
            "createPost" -> isText(v["name"], 100, 1) && jsTrim(v["name"].string()!!) != "" && content(v["content"])
            "removeAttachment" -> isInteger(v["index"]) && v["index"].number()!! >= 0 && v["index"].number()!! < MAX_ATTACHMENTS
            "edit" -> id(v["messageId"]) && content(v["content"])
            "delete" -> id(v["messageId"])
            "react" -> id(v["messageId"]) && isText(v["emoji"], 64, 1) && isBoolean(v["add"])
            else -> false
        }
    }
}
