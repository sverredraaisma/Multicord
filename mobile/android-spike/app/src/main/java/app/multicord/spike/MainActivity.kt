// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.hardware.camera2.CameraManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast

/** The main screen: one button per spike and the results log with "Copy results". */
class MainActivity : Activity() {
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var usbView: TextView
    private lateinit var sizeChoice: Spinner
    private val onLog: () -> Unit = { refreshLog() }
    private val onUsb: () -> Unit = { refreshUsb() }
    private var cameraWatch: CameraManager.AvailabilityCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = Ui.column(this)
        val buttons = Ui.column(this)
        addButtons(buttons)
        addUsbSection(buttons)
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
        UsbCamera.init(this)
        UsbCamera.listen(onUsb)
        noteUsbIntent(intent)
        refreshLog()
        refreshUsb()
    }

    override fun onDestroy() {
        cameraWatch?.let { NativeCameras.unwatch(this, it) }
        SpikeLog.unlisten(onLog)
        UsbCamera.unlisten(onUsb)
        super.onDestroy()
    }

    /** Started (or brought back, singleTop) by plugging in a camera that matches res/xml/usb_device_filter.xml. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        noteUsbIntent(intent)
    }

    private fun noteUsbIntent(intent: Intent?) {
        if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            SpikeLog.add("uvc", "app opened by a USB camera being plugged in")
            refreshUsb()
        }
    }

    /** Spike 0.5: the first UVC device, its permission, and the stream. */
    private fun addUsbSection(into: LinearLayout) {
        into.addView(TextView(this).apply {
            text = "0.5 USB camera"
            setTypeface(typeface, Typeface.BOLD)
            setPadding(Ui.dp(this@MainActivity, 8), Ui.dp(this@MainActivity, 4), 0, 0)
        })
        sizeChoice = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                UsbCamera.choices.map { "${it.width}x${it.height} @ ${it.fps}" })
        }
        into.addView(Ui.row(this,
            button("USB devices") { UsbCamera.dump(); refreshUsb() },
            button("Allow") { firstCamera()?.let { UsbCamera.requestPermission(it) } },
            button("Start") { firstCamera()?.let { UsbCamera.start(it, UsbCamera.choices[sizeChoice.selectedItemPosition]) } },
            button("Stop") { UsbCamera.stop() },
            sizeChoice,
            button("Replay test frames") { UsbCamera.startReplay() },
        ))
        usbView = TextView(this).apply {
            textSize = 12f
            setPadding(Ui.dp(this@MainActivity, 8), 0, Ui.dp(this@MainActivity, 8), Ui.dp(this@MainActivity, 4))
        }
        into.addView(usbView)
    }

    private fun firstCamera(): UsbDevice? =
        UsbCamera.uvcDevices().firstOrNull().also { if (it == null) SpikeLog.add("uvc", "no USB video device attached") }

    private fun refreshUsb() {
        val devices = UsbCamera.uvcDevices()
        val lines = if (devices.isEmpty()) mutableListOf("No USB video device attached.") else devices.map { UsbCamera.summary(it) }.toMutableList()
        val status = UsbCamera.status
        val rates = UsbCamera.rates
        lines += when {
            status == null -> "Not streaming."
            rates == null -> "Streaming ${status.name} at ${status.width}x${status.height} @ ${status.fps}, counting"
            else -> "Streaming ${status.name} at ${status.width}x${status.height} @ ${status.fps}: %.1f fps, %.1f to pages, %.0f KB/s, %d dropped, %d page drops".format(
                rates.fps, rates.sentFps, rates.bytesPerSecond / 1024.0, rates.dropped, rates.pageDrops)
        }
        usbView.text = lines.joinToString("\n")
    }

    private fun addButtons(into: LinearLayout) {
        val desktopUa = CheckBox(this).apply { text = "Desktop user agent"; isChecked = true }
        val testCamera = CheckBox(this).apply { text = "Test camera in Discord (0.3)" }
        val usbCamera = CheckBox(this).apply { text = "USB camera in Discord (0.5)" }
        into.addView(Ui.row(this,
            button("0.1 Discord") {
                startActivity(WebActivity.discord(this, desktopUa.isChecked, testCamera.isChecked, usbCamera.isChecked))
            },
            desktopUa,
            testCamera,
            usbCamera,
        ))
        into.addView(Ui.row(this,
            button("0.2 Camera page") { startActivity(WebActivity.page(this, "camera.html")) },
            button("Camera2 + USB") { NativeCameras.report(this) },
        ))
        into.addView(Ui.row(this,
            button("0.3/0.5 Camera page + virtual cameras") {
                startActivity(WebActivity.page(this, "camera.html", testCamera = true, usbCamera = true))
            },
            button("0.4 Decode cost") { startActivity(WebActivity.page(this, "decode.html")) },
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
