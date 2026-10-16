// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.secrets

import java.io.File
import java.io.IOException
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Encrypts secrets; `aad` binds each value to its instance and key (see [SecretStore]). */
interface SecretCipher {
    fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray

    /** Throws when the value was not encrypted by this key for this `aad`. */
    fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray
}

/** One instance's secrets: what an engine's secretLoad/secretSave/secretDelete reach, and nothing else. */
interface ScopedSecrets {
    fun load(key: String): String?
    fun save(key: String, value: String)
    fun delete(key: String)
}

/**
 * Module secrets, as src/main/credentials.ts keeps them on the desktop: encrypted (here with a
 * non-exportable Android Keystore key, [KeystoreCipher]) in app-private storage, one file per instance.
 *
 * An engine only ever gets [scope] for the instance id the native side gave its WebView, so it cannot
 * name another instance's secrets. Each value is encrypted with its instance and key as associated data,
 * so a value copied to another slot in the files does not decrypt either.
 */
class SecretStore(private val dir: File, private val cipher: SecretCipher) {
    private val memory = HashMap<String, MutableMap<String, String>>()

    fun scope(instanceId: String): ScopedSecrets {
        require(INSTANCE_ID.matches(instanceId)) { "Invalid instance id: $instanceId" }
        return object : ScopedSecrets {
            override fun load(key: String): String? = this@SecretStore.load(instanceId, key)
            override fun save(key: String, value: String) = this@SecretStore.save(instanceId, key, value)
            override fun delete(key: String) = this@SecretStore.delete(instanceId, key)
        }
    }

    /** Forgets every secret of an instance, e.g. one the user removed. */
    @Synchronized
    fun forget(instanceId: String) {
        require(INSTANCE_ID.matches(instanceId)) { "Invalid instance id: $instanceId" }
        memory.remove(instanceId)
        fileOf(instanceId).delete()
    }

    @Synchronized
    private fun load(instanceId: String, key: String): String? {
        memory[instanceId]?.get(key)?.let { return it }
        val encoded = readAll(instanceId)[key] ?: return null
        return try {
            val plain = String(cipher.decrypt(Base64.getDecoder().decode(encoded), aad(instanceId, key)), Charsets.UTF_8)
            memory.getOrPut(instanceId) { HashMap() }[key] = plain
            plain
        } catch (_: Exception) {
            // Encrypted under a key that is gone (app data restored elsewhere), or moved to another slot.
            null
        }
    }

    @Synchronized
    private fun save(instanceId: String, key: String, value: String) {
        val all = readAll(instanceId)
        checkQuota(all, key, value)
        all[key] = Base64.getEncoder().encodeToString(cipher.encrypt(value.toByteArray(Charsets.UTF_8), aad(instanceId, key)))
        writeAll(instanceId, all)
        memory.getOrPut(instanceId) { HashMap() }[key] = value
    }

    @Synchronized
    private fun delete(instanceId: String, key: String) {
        memory[instanceId]?.remove(key)
        val all = readAll(instanceId)
        if (all.remove(key) != null) writeAll(instanceId, all)
    }

    /** Throws when saving `value` under `key` would take the instance past its share, as on the desktop. */
    private fun checkQuota(all: Map<String, String>, key: String, value: String) {
        val sizes = HashMap<String, Int>()
        for ((name, stored) in all) sizes[name] = stored.length
        sizes[key] = value.length
        if (sizes.size > MAX_SCOPED_SECRETS || sizes.values.sum() > MAX_SCOPED_CHARS) throw IOException("This service keeps too many secrets")
    }

    private fun fileOf(instanceId: String) = File(dir, "$instanceId.json")

    private fun readAll(instanceId: String): MutableMap<String, String> {
        val file = fileOf(instanceId)
        if (!file.isFile) return LinkedHashMap()
        return try {
            val parsed = Json.parseToJsonElement(file.readText()) as? JsonObject ?: return LinkedHashMap()
            val out = LinkedHashMap<String, String>()
            for ((name, value) in parsed) if (value is JsonPrimitive && value.isString) out[name] = value.content
            out
        } catch (_: Exception) {
            LinkedHashMap()
        }
    }

    /** Writes the instance's file whole, through a temporary file, so a crash never leaves half of it. */
    private fun writeAll(instanceId: String, all: Map<String, String>) {
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create $dir")
        val file = fileOf(instanceId)
        val temp = File(dir, "$instanceId.json.tmp")
        temp.writeText(JsonObject(all.mapValues { JsonPrimitive(it.value) }).toString())
        if (!temp.renameTo(file)) {
            file.delete()
            if (!temp.renameTo(file)) throw IOException("Cannot write $file")
        }
    }

    companion object {
        /** Secrets one instance may keep, and characters of stored values, all keys together (credentials.ts). */
        const val MAX_SCOPED_SECRETS = 64
        const val MAX_SCOPED_CHARS = 512 * 1024
        private val INSTANCE_ID = Regex("^[a-z0-9][a-z0-9-]{0,31}$")

        /** The associated data a value is encrypted with: its instance and key, so it decrypts nowhere else. */
        fun aad(instanceId: String, key: String): ByteArray {
            val separator = Char(0)
            return "multicord-secret$separator$instanceId$separator$key".toByteArray(Charsets.UTF_8)
        }
    }
}
