// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.net

/**
 * An engine's one voice host, as EngineHub.addVoiceHost (src/main/engineHost.ts) grants it: one more host for
 * the engine's WebSockets alone (never its HTTP, nor its view), for a module that declares it, while the engine
 * says the user is signed in, once, and only with the registrable domain of a host the engine is locked to.
 */
class VoiceHostGrant(private val declared: Boolean) {
    /** The host granted, if any. */
    var host: String? = null
        private set

    /** Grants `requested` (or says why not); an engine not locked reaches it already, and nothing is recorded. */
    fun add(allowed: List<String>?, signedIn: Boolean, requested: String, suffixes: () -> PublicSuffixList): Result<String> {
        if (!declared) return Result.failure(IllegalStateException("This module adds no voice host"))
        if (!signedIn) return Result.failure(IllegalStateException("A voice host is added only while signed in"))
        host?.let { granted ->
            return if (granted == requested) Result.success(requested) else Result.failure(IllegalStateException("This service has added its voice host already"))
        }
        if (allowed == null) return Result.success(requested)
        if (NetPolicy.isPrivateHost(requested) || !suffixes().voiceHostAllowed(allowed, requested)) {
            return Result.failure(IllegalStateException("$requested is not on the domain of this service's hosts"))
        }
        host = requested
        return Result.success(requested)
    }

    /** The hosts the engine's sockets may reach: the lock's and the voice host. */
    fun socketHosts(allowed: List<String>?): List<String>? = host?.let { voice -> allowed?.plus(voice) } ?: allowed

    /** After a narrower lock: the voice host stays only while it is on the domain of a host still allowed. */
    fun narrowed(hosts: List<String>, suffixes: () -> PublicSuffixList) {
        host?.let { if (!suffixes().voiceHostAllowed(hosts, it)) host = null }
    }
}
