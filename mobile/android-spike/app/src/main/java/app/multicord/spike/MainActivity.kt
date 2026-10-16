// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Typeface
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/** The main screen: one button per spike and the results log with "Copy results". */
class MainActivity : Activity() {
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private val onLog: () -> Unit = { refreshLog() }

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
        refreshLog()
    }

    override fun onDestroy() {
        SpikeLog.unlisten(onLog)
        super.onDestroy()
    }

    private fun addButtons(into: LinearLayout) {
        into.addView(Ui.row(this,
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

    private fun copyResults() {
        val clipboard = getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Multicord spike results", SpikeLog.text()))
        Toast.makeText(this, "Results copied", Toast.LENGTH_SHORT).show()
    }

    private fun refreshLog() {
        logView.text = SpikeLog.text()
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }
}
