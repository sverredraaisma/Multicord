// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import app.multicord.engine.ModuleTable
import app.multicord.engine.NativeModule
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ShellFilesTest {
    private fun dir(): File = Files.createTempDirectory("shell-files").toFile().resolve("shell")

    @Test
    fun keepsTheShellsFilesOnly() {
        val files = ShellFiles(dir())
        assertNull(files.read("settings"))
        assertEquals(emptyMap<String, String>(), files.all())
        files.write("settings", "{\"a\":1}")
        files.write("platforms", "[]")
        files.write("platforms", "[1]")
        assertEquals("{\"a\":1}", files.read("settings"))
        assertEquals(mapOf("settings" to "{\"a\":1}", "platforms" to "[1]"), files.all())
        assertThrows(IllegalArgumentException::class.java) { files.write("credentials", "x") }
        assertThrows(IllegalArgumentException::class.java) { files.read("../secrets/matrix") }
        assertThrows(IllegalArgumentException::class.java) { files.write("order", "x".repeat(ShellCommands.MAX_FILE + 1)) }
    }

    @Test
    fun readsTheModuleTableTheBuildWrites() {
        val table = ModuleTable.parse(
            """[
              {"id": "matrix-native", "engine": "matrix", "storage": true},
              {"id": "telegram", "engine": "telegram", "storage": false, "hosts": ["*.web.telegram.org"]},
              {"id": "spacebar-native", "engine": "spacebar", "storage": false, "voiceHost": "sibling"},
              {"id": "voice-other", "engine": "x", "voiceHost": "any"},
              {"id": "voice-list", "engine": "x", "voiceHost": ["sibling"]},
              {"id": "Bad", "engine": "x"},
              {"id": "bad-engine", "engine": "../x"},
              {"id": "bad-hosts", "engine": "x", "hosts": ["*"]},
              {"id": "no-hosts", "engine": "x", "hosts": []},
              {"id": "hosts-text", "engine": "x", "hosts": "a.b"},
              {"engine": "x"},
              {"id": "web", "storage": true, "web": true},
              {"id": "web-engine", "engine": "x", "storage": true, "web": true},
              {"id": "web-hosts", "hosts": ["a.b"], "web": true},
              {"id": "Web", "web": true},
              {"id": "discord", "storage": true, "discord": true},
              {"id": "discord-engine", "engine": "x", "discord": true},
              {"id": "discord-web", "web": true, "discord": true},
              5
            ]""",
        )
        assertEquals(NativeModule("matrix-native", "matrix", null, true), table["matrix-native"])
        assertEquals(NativeModule("telegram", "telegram", listOf("*.web.telegram.org"), false), table["telegram"])
        assertEquals(NativeModule("spacebar-native", "spacebar", null, false, voiceHost = true), table["spacebar-native"])
        assertEquals(NativeModule("web", null, null, true, web = true), table["web"])
        assertEquals(NativeModule("discord", null, null, true, discord = true), table["discord"])
        assertEquals(setOf("matrix-native", "telegram", "spacebar-native", "web", "discord"), table.ids)
        assertEquals(emptySet<String>(), ModuleTable.parse("{}").ids)
    }
}
