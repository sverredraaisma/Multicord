// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.WebViewFeature
import app.multicord.engine.EngineHost
import app.multicord.engine.EngineListener
import app.multicord.engine.EngineSpec
import app.multicord.secrets.KeystoreCipher
import app.multicord.secrets.SecretStore
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Phase 2, milestone 1: one module instance (Matrix) in its engine. A status line shows the engine's
 * state and account; the module's view comes with the shell.
 */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private var engine: EngineHost? = null
    private var engineState = "starting"
    private var account = "unknown"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(24, 12, 24, 12)
        }
        val content = FrameLayout(this)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
            addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })

        val missing = REQUIRED_FEATURES.filterNot(WebViewFeature::isFeatureSupported)
        if (missing.isNotEmpty()) {
            status.text = "This phone's Android System WebView is too old for Multicord (missing ${missing.joinToString()}). Update it from your app store."
            return
        }
        // Inspecting pages over adb, in debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val secrets = SecretStore(File(filesDir, "secrets"), KeystoreCipher())
        val host = EngineHost(this, MATRIX, secrets.scope(MATRIX.instanceId), content, object : EngineListener {
            override fun onEvent(host: EngineHost, event: JsonObject) {
                if ((event["type"] as JsonPrimitive).content == "account") {
                    account = ((event["account"] as JsonObject)["state"] as JsonPrimitive).content
                    showStatus()
                }
            }

            override fun onRender(host: EngineHost, state: JsonObject) {
                if (BuildConfig.DEBUG) Log.d(EngineHost.TAG, "[engine ${host.spec.instanceId}] rendered ${(state["screen"] as? JsonPrimitive)?.content}")
            }

            override fun onHealth(host: EngineHost, state: String) {
                engineState = state
                Log.i(EngineHost.TAG, "[engine ${host.spec.instanceId}] $state")
                showStatus()
            }
        })
        engine = host
        host.start()
        showStatus()
    }

    private fun showStatus() {
        status.text = "${MATRIX.name} · engine $engineState · $account"
    }

    override fun onDestroy() {
        engine?.destroy()
        engine = null
        super.onDestroy()
    }

    private companion object {
        val REQUIRED_FEATURES = listOf(WebViewFeature.MULTI_PROFILE, WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)

        /** The desktop's "matrix-native" module (src/main/modules/matrix.ts) with its default settings. */
        val MATRIX = EngineSpec(
            instanceId = "matrix-native",
            engine = "matrix",
            name = "Matrix",
            url = "https://matrix.org",
            settings = JsonObject(mapOf("readReceipts" to JsonPrimitive(true), "slidingSync" to JsonPrimitive(true))),
        )
    }
}
