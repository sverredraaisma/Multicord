// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.secrets

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** The store with the same AES-GCM as the Keystore's, in software (the Keystore exists only on a device). */
class SecretStoreTest {
    private class SoftwareCipher : SecretCipher {
        private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        override fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray {
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            return iv + cipher.doFinal(plain)
        }
        override fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob, 0, 12))
            cipher.updateAAD(aad)
            return cipher.doFinal(blob, 12, blob.size - 12)
        }
    }

    private val dir: File = Files.createTempDirectory("secrets").toFile()
    private val cipher = SoftwareCipher()

    @Test
    fun keepsEachInstancesSecretsApartAndEncrypted() {
        val store = SecretStore(dir, cipher)
        val matrix = store.scope("matrix-native")
        val other = store.scope("fluxer")
        matrix.save("session", "token-123")
        assertEquals("token-123", matrix.load("session"))
        assertNull(other.load("session"))
        // A new store (an app restart) reads it back from the file, which holds no plain text.
        assertEquals("token-123", SecretStore(dir, cipher).scope("matrix-native").load("session"))
        assertFalse(File(dir, "matrix-native.json").readText().contains("token-123"))
        matrix.delete("session")
        assertNull(SecretStore(dir, cipher).scope("matrix-native").load("session"))
    }

    @Test
    fun aValueMovedToAnotherSlotDoesNotDecrypt() {
        SecretStore(dir, cipher).scope("matrix-native").save("session", "secret")
        val stored = Json.parseToJsonElement(File(dir, "matrix-native.json").readText()).jsonObject["session"]!!
        File(dir, "fluxer.json").writeText(JsonObject(mapOf("session" to stored)).toString())
        File(dir, "matrix-native.json").writeText(JsonObject(mapOf("session" to stored, "other" to stored)).toString())
        val fresh = SecretStore(dir, cipher)
        assertNull(fresh.scope("fluxer").load("session"))
        assertNull(fresh.scope("matrix-native").load("other"))
        assertEquals("secret", fresh.scope("matrix-native").load("session"))
        // Nor does one encrypted by another key (another device).
        assertNull(SecretStore(dir, SoftwareCipher()).scope("matrix-native").load("session"))
        File(dir, "matrix-native.json").writeText(JsonObject(mapOf("session" to JsonPrimitive("not base64!"))).toString())
        assertNull(SecretStore(dir, cipher).scope("matrix-native").load("session"))
    }

    @Test
    fun refusesBadInstanceIdsAndTooMuch() {
        val store = SecretStore(dir, cipher)
        for (id in listOf("", "../x", "A", "a/b", "x".repeat(33))) assertThrows(IllegalArgumentException::class.java) { store.scope(id) }
        val scoped = store.scope("stoat")
        for (i in 0 until SecretStore.MAX_SCOPED_SECRETS) scoped.save("k$i", "v")
        assertThrows(IOException::class.java) { scoped.save("one-more", "v") }
        scoped.save("k0", "replaced")
        val big = store.scope("big")
        assertThrows(IOException::class.java) { big.save("k", "x".repeat(SecretStore.MAX_SCOPED_CHARS + 1)) }
        store.forget("stoat")
        assertNull(store.scope("stoat").load("k1"))
        assertFalse(File(dir, "stoat.json").exists())
    }
}
