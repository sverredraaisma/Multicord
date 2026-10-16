// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.engine

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * What a module needs: its engine's bundle, the only hosts the engine may reach (null: any public host), its
 * storage; or, for a web-client module (`web`), nothing but that: the service's own web app in a plain WebView;
 * or Discord (`discord`): Discord's own web app in the Discord view.
 */
data class NativeModule(val id: String, val engine: String?, val hosts: List<String>?, val storage: Boolean, val web: Boolean = false, val discord: Boolean = false)

/**
 * The modules the app runs, from dist/mobile/modules.json, which the desktop build writes from the
 * modules' own manifests (src/mobile/modules.ts). The shell page names a module when it starts an
 * instance; its engine, host lock and storage come from here, never from the page.
 */
class ModuleTable(private val modules: Map<String, NativeModule>) {
    operator fun get(id: String): NativeModule? = modules[id]

    val ids: Set<String> get() = modules.keys

    companion object {
        private val ID = Regex("^[a-z0-9][a-z0-9-]{0,31}$")
        private val ENGINE = Regex("^[a-z0-9-]{1,32}$")
        private val HOST = Regex("^(\\*\\.)?[a-z0-9]([a-z0-9-]{0,62})(\\.[a-z0-9]([a-z0-9-]{0,62}))+$")

        /** Reads the table; an entry that does not check out is left out. */
        fun parse(text: String): ModuleTable {
            val entries = Json.parseToJsonElement(text) as? JsonArray ?: return ModuleTable(emptyMap())
            val modules = LinkedHashMap<String, NativeModule>()
            for (entry in entries) {
                val e = entry as? JsonObject ?: continue
                val id = (e["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
                if ((e["discord"] as? JsonPrimitive)?.booleanOrNull == true) {
                    // Discord's own web app, no engine, no host lock: an entry that names one is not Discord's.
                    if (ID.matches(id) && e["engine"] == null && e["hosts"] == null && e["web"] == null) modules[id] = NativeModule(id, null, null, storage = true, discord = true)
                    continue
                }
                if ((e["web"] as? JsonPrimitive)?.booleanOrNull == true) {
                    // A web client has no engine and no host lock: an entry that names one is not one.
                    if (ID.matches(id) && e["engine"] == null && e["hosts"] == null) modules[id] = NativeModule(id, null, null, storage = true, web = true)
                    continue
                }
                val engine = (e["engine"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
                if (!ID.matches(id) || !ENGINE.matches(engine)) continue
                val hosts = when (val h = e["hosts"]) {
                    null -> null
                    is JsonArray -> h.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: "" }
                    else -> continue
                }
                if (hosts != null && (hosts.isEmpty() || !hosts.all(HOST::matches))) continue
                val storage = (e["storage"] as? JsonPrimitive)?.booleanOrNull ?: false
                modules[id] = NativeModule(id, engine, hosts, storage)
            }
            return ModuleTable(modules)
        }
    }
}
