// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.shell

import java.io.File
import java.io.IOException

/**
 * The shell page's files (settings.json, platforms.json, rail-order.json on the desktop), kept for it in
 * app-private storage: core's SettingsPersistence and PlatformsConfig on the phone. Only the names in
 * [ShellCommands.FILES]; each written whole through a temporary file, so a crash never leaves half of one.
 * Excluded from backups with everything else (data_extraction_rules.xml).
 */
class ShellFiles(private val dir: File) {
    private fun fileOf(name: String): File {
        require(name in ShellCommands.FILES) { "Unknown shell file: $name" }
        return File(dir, "$name.json")
    }

    /** The file's text, or null when there is none (or it cannot be read). */
    fun read(name: String): String? {
        val file = fileOf(name)
        return try {
            if (file.isFile) file.readText() else null
        } catch (_: IOException) {
            null
        }
    }

    fun write(name: String, text: String) {
        require(text.length <= ShellCommands.MAX_FILE) { "Too large" }
        val file = fileOf(name)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Cannot create $dir")
        val temp = File(dir, "$name.json.tmp")
        temp.writeText(text)
        if (!temp.renameTo(file)) {
            file.delete()
            if (!temp.renameTo(file)) throw IOException("Cannot write $file")
        }
    }

    /** Every file there is, by name: what the page gets at boot. */
    fun all(): Map<String, String> = ShellCommands.FILES.mapNotNull { name -> read(name)?.let { name to it } }.toMap()
}
