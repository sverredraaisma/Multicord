// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.hardware.camera2.CameraManager
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** The main screen: one button per spike and the results log with "Copy results". */
class MainActivity : Activity() {
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private val onLog: () -> Unit = { refreshLog() }
    private var cameraWatch: CameraManager.AvailabilityCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)
        val buttons = Ui.column(this)
        addButtons(buttons)
        root.addView(buttons)

        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            setPadding(Ui.dp(this@MainActivity, 8), 0, Ui.dp(this@MainActivity, 8), 0)
        }
        logScroll = ScrollView(this).apply { addView(logView) }
        root.addView(logScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(Ui.withInsets(root))

        SpikeLog.listen(onLog)
        if (savedInstanceState == null) Features.report(this)
        cameraWatch = NativeCameras.watch(this)
        refreshLog()
    }

    override fun onDestroy() {
        cameraWatch?.let { NativeCameras.unwatch(this, it) }
        SpikeLog.unlisten(onLog)
        super.onDestroy()
    }

    private fun addButtons(into: LinearLayout) {
        val desktopUa = CheckBox(this).apply { text = "Desktop user agent"; isChecked = true }
        val testCamera = CheckBox(this).apply { text = "Test camera in Discord (0.3)" }
        into.addView(Ui.row(this,
            button("0.1 Discord") { startActivity(WebActivity.discord(this, desktopUa.isChecked, testCamera.isChecked)) },
            desktopUa,
            testCamera,
        ))
        into.addView(Ui.row(this,
            button("0.2 Camera page") { startActivity(WebActivity.page(this, "camera.html")) },
            button("Camera2 + USB") { NativeCameras.report(this) },
            button("0.3 Camera page + test camera") { startActivity(WebActivity.page(this, "camera.html", testCamera = true)) },
        ))
        into.addView(Ui.row(this,
            button("Grant camera + mic") { requestMedia() },
            button("WebView features") { Features.report(this) },
            button("Copy results") { copyResults() },
            button("Clear") { SpikeLog.clear() },
        ))
    }

    private fun button(label: String, action: () -> Unit): View =
        Button(this).apply {
            text = label
            isAllCaps = false
            setOnClickListener { action() }
        }

    /** The WebViews only get camera/microphone after the app holds them; asking up front saves a step later. */
    private fun requestMedia() {
        requestPermissions(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO), REQUEST_MEDIA)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != REQUEST_MEDIA) return
        permissions.forEachIndexed { i, permission ->
            val ok = grantResults.getOrNull(i) == PackageManager.PERMISSION_GRANTED
            SpikeLog.add("permissions", "${permission.substringAfterLast('.')}: ${if (ok) "granted" else "refused"}")
        }
    }

    private fun copyResults() {
        val clipboard = getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Multicord spike results", SpikeLog.text()))
        Toast.makeText(this, "Results copied", Toast.LENGTH_SHORT).show()
    }

    private fun refreshLog() {
        logView.text = SpikeLog.text()
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private companion object {
        const val REQUEST_MEDIA = 1
    }
}
