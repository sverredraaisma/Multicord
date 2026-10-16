// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.browser.customtabs.CustomTabsIntent
import app.multicord.background.NotificationTarget

/**
 * The screen: the shell page (src/core with the bar, the drawer and the settings page) over the chat view
 * of the service it shows, one view at a time. Everything behind them lives in the [Hub], which keeps
 * running when this activity goes away.
 */
class MainActivity : Activity(), Hub.Screen {
    private lateinit var root: FrameLayout
    private lateinit var viewArea: FrameLayout
    private var hub: Hub? = null
    /** The open document picker's caller; one picker at a time. */
    private var picking: ((List<String>) -> Unit)? = null
    /** The open permission request's caller and what it asked; one request at a time. */
    private var permitting: Pair<List<String>, (Set<String>) -> Unit>? = null
    private var backCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as MulticordApp
        app.webViewProblem?.let { problem ->
            // Nothing starts: no Hub, no engines, no background service.
            Log.w(TAG, "WebView not supported: ${problem.message}")
            setContentView(TextView(this).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                setPadding(48, 48, 48, 48)
                setTextColor(Color.WHITE)
                setBackgroundColor(BACKGROUND)
                text = problem.message
            })
            return
        }
        // Inspecting pages over adb, in debug builds only.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        root = FrameLayout(this).apply {
            fitsSystemWindows = true
            setBackgroundColor(BACKGROUND)
        }
        viewArea = FrameLayout(this)
        root.addView(viewArea, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply { topMargin = barHeight() })
        setContentView(root)
        val hub = app.hub()
        this.hub = hub
        hub.attach(this, this)
        NotificationTarget.from(intent)?.let(hub::openNotification)
        // Android 13 and later ask before an app may notify; asked once, the system remembers a refusal.
        if (Build.VERSION.SDK_INT >= 33 && !hub.notifier.allowed()) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFY)
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = OnBackInvokedCallback { hub.back() }.also {
                onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, it)
            }
        }
    }

    /** The shell page's bar: 56 dp, as its CSS (--bar) has it. */
    private fun barHeight() = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 56f, resources.displayMetrics).toInt()

    override fun place(shell: WebView?, view: WebView?, shellFull: Boolean) {
        for (i in viewArea.childCount - 1 downTo 0) if (viewArea.getChildAt(i) !== view) viewArea.removeViewAt(i)
        if (view != null && view.parent !== viewArea) {
            (view.parent as? ViewGroup)?.removeView(view)
            viewArea.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        for (i in root.childCount - 1 downTo 0) {
            val child = root.getChildAt(i)
            if (child !== viewArea && child !== shell) root.removeViewAt(i)
        }
        if (shell == null) return
        val params = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, if (shellFull) ViewGroup.LayoutParams.MATCH_PARENT else barHeight())
        if (shell.parent !== root) {
            (shell.parent as? ViewGroup)?.removeView(shell)
            // Above the chat view: its bar, and its drawer over the view.
            root.addView(shell, params)
        } else {
            shell.layoutParams = params
        }
    }

    override fun onStart() {
        super.onStart()
        hub?.setAppVisible(true)
    }

    override fun onStop() {
        hub?.setAppVisible(false)
        super.onStop()
    }

    @Deprecated("Back before Android 13; later versions use OnBackInvokedCallback")
    override fun onBackPressed() {
        val hub = hub
        @Suppress("DEPRECATION")
        if (hub == null) super.onBackPressed() else hub.back()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        NotificationTarget.from(intent)?.let { hub?.openNotification(it) }
    }

    override fun leave() {
        moveTaskToBack(true)
    }

    override fun close() {
        finishAndRemoveTask()
    }

    override fun pickDocuments(done: (List<String>) -> Unit): Boolean {
        if (picking != null) return false
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        return try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQUEST_PICK)
            picking = done
            true
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "No document picker: ${error.message}")
            false
        }
    }

    override fun requestPermissions(permissions: List<String>, done: (Set<String>) -> Unit): Boolean {
        val held = permissions.filter { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }.toSet()
        if (held.size == permissions.size) {
            done(held)
            return true
        }
        if (permitting != null) return false
        permitting = permissions to done
        requestPermissions(permissions.toTypedArray(), REQUEST_PERMISSIONS)
        return true
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_PERMISSIONS) return
        val (asked, done) = permitting ?: return
        permitting = null
        done(asked.filter { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }.toSet())
    }

    override fun openBrowser(url: String): Boolean = try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, Uri.parse(url))
        true
    } catch (error: ActivityNotFoundException) {
        Log.w(TAG, "No browser: ${error.message}")
        false
    }

    @Deprecated("Activity results for the document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK) return
        val done = picking ?: return
        picking = null
        val uris = ArrayList<String>()
        if (resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris += it.toString() }
            } else {
                data.data?.let { uris += it.toString() }
            }
        }
        done(uris)
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= 33) backCallback?.let(onBackInvokedDispatcher::unregisterOnBackInvokedCallback)
        // A picker this activity opened can no longer answer.
        picking?.invoke(emptyList())
        picking = null
        permitting?.second?.invoke(emptySet())
        permitting = null
        hub?.detach(this)
        hub = null
        super.onDestroy()
    }

    private companion object {
        const val TAG = "Multicord"
        const val REQUEST_PICK = 1
        const val REQUEST_NOTIFY = 2
        const val REQUEST_PERMISSIONS = 3
        val BACKGROUND = Color.rgb(0x1e, 0x1f, 0x22)
    }
}
