// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.PermissionRequest
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import app.multicord.background.ConnectionService
import app.multicord.background.NotificationTarget
import app.multicord.background.Notifier
import app.multicord.bridge.Validators
import app.multicord.call.AudioRoute
import app.multicord.call.Call
import app.multicord.call.CallAudio
import app.multicord.call.CallPolicy
import app.multicord.camera.UsbCamera
import app.multicord.discord.DiscordView
import app.multicord.engine.EngineHost
import app.multicord.engine.EngineListener
import app.multicord.engine.EngineSpec
import app.multicord.engine.EngineUi
import app.multicord.engine.ModuleTable
import app.multicord.secrets.KeystoreCipher
import app.multicord.secrets.SecretStore
import app.multicord.shell.ChatView
import app.multicord.shell.ShellFiles
import app.multicord.shell.ShellHost
import app.multicord.shell.WebClientView
import java.io.File
import java.util.concurrent.Executors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Everything that runs, for as long as the app runs (not only while an activity is on screen): the shell
 * page with src/core, an engine per native service instance and its chat view, a plain WebView per
 * web-client instance (the service's own web app, which gets nothing of Multicord's), and a Discord view per
 * Discord instance (Discord's web app with the desktop's hooks; its reports go to the shell page, checked). It does what
 * Electron's main process does on the desktop besides core: it starts and stops engines and views as the
 * shell page says, keeps the shell's files, and routes between them. The routes are fixed here: an
 * engine's events go to the shell page (tagged with the instance native code started in that WebView),
 * its display state to its own chat view only, a view's actions to its own engine only. Engines and views
 * never reach the shell page or each other.
 *
 * Main thread only. An activity shows the shell page and the chosen chat view while it is on screen
 * ([attach]); the WebViews are made with a MutableContextWrapper, so the activity can be their context
 * while they are shown (pickers, selects) and the application while they are not.
 */
class Hub(private val app: Context) : EngineUi, WebClientView.Ui {
    /** What an activity does for the hub: show the WebViews, open pickers and the browser, leave. */
    interface Screen {
        /** Shows the shell page (the whole screen, or just its bar over `view`) and the chat view; nulls remove them. */
        fun place(shell: WebView?, view: WebView?, shellFull: Boolean)
        fun pickDocuments(done: (List<String>) -> Unit): Boolean
        fun openBrowser(url: String): Boolean

        /** Asks for Android permissions the user has not granted yet; `done` gets those granted. */
        fun requestPermissions(permissions: List<String>, done: (Set<String>) -> Unit): Boolean
        /** The user went back past everything: the app leaves the screen, its services keep running. */
        fun leave()

        /** The user quit: the screen goes too. */
        fun close()

        /** A call is in progress (null: none): the screen stays on for video, volume keys set the call's volume. */
        fun inCall(call: Call?)

        /** The theme setting ("system", "light" or "dark"): the screen behind the pages and the system bars follow it. */
        fun theme(theme: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val secrets = SecretStore(File(app.filesDir, "secrets"), KeystoreCipher())
    private val files = ShellFiles(File(app.filesDir, "shell"))
    private val profilesToDelete = File(app.filesDir, "profiles-to-delete.json")
    private val modules = ModuleTable.parse(app.assets.open("web/mobile/modules.json").bufferedReader().use { it.readText() })
    private val instances = LinkedHashMap<String, Instance>()
    private val shellContext = MutableContextWrapper(app)
    private var shell: ShellHost? = null
    private var screen: Screen? = null
    private var shown: String? = null
    private var overlay = false
    private var appVisible = false
    private var booted = false
    private var nextBack = 0L
    private var waitingBack: Long? = null
    /** The theme setting, as the shell page last said. */
    private var theme = "system"

    /** The launcher badge's count, as the shell page last said. */
    var badge = 0
        private set

    val notifier = Notifier(app)

    /** Instances running now, and who wants to hear when that changes (the connected notification). */
    val running: Int get() = instances.size
    var onRunningChanged: ((Int) -> Unit)? = null
    private var pendingOpen: NotificationTarget? = null

    /** Calls in progress, by instance, as their engines' display state says; the first one has the phone's audio. */
    private val callsByInstance = LinkedHashMap<String, Call>()
    val calls: List<Call> get() = callsByInstance.values.toList()
    /** Who wants to hear when calls start, end or turn video on or off (the background service's types and notification). */
    var onCallsChanged: (() -> Unit)? = null
    /** The phone's USB camera (Tier B), made when a view first needs it; shared by every view whose service has it on. */
    private var usbCamera: UsbCamera? = null
    private fun camera(): UsbCamera = usbCamera ?: UsbCamera(app).also { usbCamera = it }

    private val callAudio = CallAudio(app) { current, available ->
        val call = callsByInstance.values.firstOrNull { it.inChatView } ?: return@CallAudio
        instances[call.instance]?.view?.audioRoutes(AudioRoute.report(current, available))
    }

    fun start() {
        deletePendingProfiles()
        // Keeps everything running while no activity is on screen (ConnectionService).
        try {
            app.startForegroundService(Intent(app, ConnectionService::class.java))
        } catch (error: Exception) {
            Log.w(TAG, "Could not start the background service: ${error.message}")
        }
        shell = ShellHost(shellContext, ::onCommand, ::onBoot).also {
            it.onReplaced = { place() }
            it.start()
        }
    }

    // The activity ----------------------------------------------------------------------------------------

    fun attach(screen: Screen, activity: Context) {
        this.screen = screen
        screen.inCall(callsByInstance.values.firstOrNull { it.inChatView })
        screen.theme(theme)
        shellContext.baseContext = activity
        for (instance in instances.values) instance.context.baseContext = activity
        place()
    }

    fun detach(screen: Screen) {
        if (this.screen !== screen) return
        screen.place(null, null, true)
        this.screen = null
        shellContext.baseContext = app
        for (instance in instances.values) instance.context.baseContext = app
    }

    fun setAppVisible(visible: Boolean) {
        appVisible = visible
        if (booted) event("appVisible", "visible" to JsonPrimitive(visible))
    }

    /**
     * The system's back: to the shown chat view first (it may go back from a conversation to its list),
     * then to the shell page (its drawer, its settings page), which says when there is nothing left.
     */
    fun back() {
        val instance = shown?.let { instances[it] }
        // A web app, and Discord, go back in their own history first.
        instance?.web?.let { web ->
            if (overlay || !web.back()) shellBack()
            return
        }
        instance?.discord?.let { discord ->
            if (overlay || !discord.back()) shellBack()
            return
        }
        val view = instance?.view
        if (overlay || view == null || !view.ready) return shellBack()
        val id = ++nextBack
        waitingBack = id
        view.back(id)
        // A view that does not answer in time does not keep the user from going back.
        main.postDelayed({ if (waitingBack == id) shellBack() }, BACK_WAIT_MS)
    }

    private fun onBackAnswer(id: Long, handled: Boolean) {
        if (waitingBack != id) return
        waitingBack = null
        if (!handled) shellBack()
    }

    private fun shellBack() {
        waitingBack = null
        if (booted) event("back") else screen?.leave()
    }

    // The shell page --------------------------------------------------------------------------------------

    /** The page (re)loaded and asks for its files: whatever ran before stops, as the page starts it again. */
    private fun onBoot(reply: (Result<JsonElement>) -> Unit) {
        booted = false
        for (id in instances.keys.toList()) stop(id)
        io.execute {
            val all = files.all()
            main.post {
                val webView = WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "unknown"
                reply(Result.success(JsonObject(mapOf(
                    "files" to JsonObject(all.mapValues { JsonPrimitive(it.value) }),
                    "version" to JsonPrimitive(BuildConfig.VERSION_NAME),
                    "os" to JsonPrimitive("android ${Build.VERSION.RELEASE} (WebView $webView)"),
                ))))
                booted = true
                if (!appVisible) event("appVisible", "visible" to JsonPrimitive(false))
            }
        }
    }

    /** A ShellCommand, already checked with ShellCommands.isShellCommand. */
    private fun onCommand(command: JsonObject) {
        fun text(key: String) = (command[key] as JsonPrimitive).content
        when (text("type")) {
            "save" -> {
                val name = text("file")
                val content = text("text")
                io.execute {
                    try {
                        files.write(name, content)
                    } catch (error: Exception) {
                        Log.w(TAG, "Could not save $name: ${error.message}")
                    }
                }
            }
            "start" -> start(text("instance"), text("module"), text("name"), text("url"), command["settings"] as? JsonObject)
            "command" -> instances[text("instance")]?.engine?.command(command["command"] as JsonObject)
            "hostSettings" -> instances[text("instance")]?.let { instance ->
                val settings = command["settings"] as JsonObject
                instance.discord?.applySettings(settings)
                if (instance.engine != null) {
                    instance.usbCamera = (settings["usbCamera"] as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"
                    instance.view?.usbCamera(instance.usbCamera)
                }
            }
            "discordNavigate" -> instances[text("instance")]?.discord?.navigate(text("target"))
            "discordNotificationClick" -> instances[text("instance")]?.discord?.clickNotification(text("id"))
            "layout" -> {
                shown = (command["instance"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                overlay = (command["overlay"] as JsonPrimitive).content == "true"
                place()
            }
            "viewSettings" -> instances[text("instance")]?.let { instance ->
                val limit = command["mediaAutoLoad"] ?: JsonNull
                instance.media = limit
                instance.view?.mediaAutoLoad(limit)
            }
            // Every chat view, now and when made, and the screen.
            "theme" -> {
                theme = text("theme")
                for (instance in instances.values) instance.view?.theme(theme)
                screen?.theme(theme)
            }
            "notify" -> {
                val id = text("instance")
                if (!instances.containsKey(id)) return
                val railKey = (command["railKey"] as? JsonPrimitive)?.content
                notifier.message(NotificationTarget(id, text("target"), railKey), text("title"), text("body"), (command["urgent"] as? JsonPrimitive)?.content == "true", badge)
            }
            "badge" -> {
                badge = (command["count"] as JsonPrimitive).content.toDouble().toInt()
                if (badge == 0) notifier.clearMessages()
            }
            "clearSession" -> clearSession(text("instance"))
            "forgetSecrets" -> {
                val id = text("instance")
                // Stopped first, so the engine cannot write a secret after they are gone.
                stop(id)
                io.execute { secrets.forget(id) }
            }
            // The user's Restart for one service: its engine starts again (or its web app loads again), nothing else does.
            "restartEngine" -> instances[text("instance")]?.let { it.engine?.restart() ?: it.web?.restart() ?: it.discord?.restart() }
            "restart" -> {
                booted = false
                for (id in instances.keys.toList()) stop(id)
                shell?.reload()
            }
            "copyText" -> (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Multicord", text("text")))
            "backUnhandled" -> screen?.leave()
        }
    }

    /** A notification the user tapped: the shell page opens its conversation. */
    fun openNotification(target: NotificationTarget) {
        // Tapped while the app was not running: once the shell page has started that instance.
        if (!booted || !instances.containsKey(target.instance)) {
            pendingOpen = target
            return
        }
        val fields = mutableListOf("instance" to JsonPrimitive(target.instance), "target" to JsonPrimitive(target.target))
        if (target.railKey != null) fields += "railKey" to JsonPrimitive(target.railKey)
        event("openNotification", *fields.toTypedArray())
    }

    /** Stops everything: engines, views, the shell page and the background service. */
    fun quit() {
        booted = false
        for (id in instances.keys.toList()) stop(id)
        screen?.let {
            it.place(null, null, true)
            it.close()
        }
        screen = null
        shell?.destroy()
        shell = null
        usbCamera?.shutdown()
        usbCamera = null
        notifier.clearMessages()
        app.stopService(Intent(app, ConnectionService::class.java))
    }

    private fun event(type: String, vararg fields: Pair<String, JsonElement>) {
        shell?.event(JsonObject(mapOf("type" to JsonPrimitive(type)) + fields))
    }

    // Instances -------------------------------------------------------------------------------------------

    private inner class Instance(val id: String) : EngineListener {
        /** A native instance's engine; null for a web client. */
        var engine: EngineHost? = null
        /** A web-client instance's web app; null for a native one. */
        var web: WebClientView? = null
        /** A Discord instance's view; null for any other. */
        var discord: DiscordView? = null
        /** The chat view's context: the activity while there is one. */
        val context = MutableContextWrapper(screen?.let { shellContext.baseContext } ?: app)
        var view: ChatView? = null
        var state: JsonObject? = null
        var media: JsonElement? = null
        /** The service's "USB camera in calls", for its chat view. */
        var usbCamera = false
        var shownAt = 0L

        override fun onEvent(host: EngineHost, event: JsonObject) {
            if (instances[id] === this) event("engine", "instance" to JsonPrimitive(id), "event" to event)
        }

        // Display state goes to this instance's own view only.
        override fun onRender(host: EngineHost, state: JsonObject) {
            this.state = state
            view?.showState(state)
            if (instances[id] === this) setCall(id, Call.of(id, state))
        }

        override fun onHealth(host: EngineHost, state: String, restarts: Int, lastExit: String?) {
            Log.i(TAG, "[engine $id] $state")
            if (instances[id] !== this) return
            val fields = mutableListOf("instance" to JsonPrimitive(id), "state" to JsonPrimitive(state), "restarts" to JsonPrimitive(restarts))
            if (lastExit != null) fields += "lastExit" to JsonPrimitive(lastExit)
            event("health", *fields.toTypedArray())
        }
    }

    /**
     * Starts an instance: a native module's engine, whose engine, hosts and storage are the module table's,
     * not the page's; or a web-client module's web app at its address (https, checked by ShellCommands).
     */
    private fun start(id: String, moduleId: String, name: String, url: String, settings: JsonObject?) {
        if (instances.containsKey(id)) return
        val module = modules[moduleId]
        if (module == null) {
            Log.w(TAG, "[shell] no module \"$moduleId\" for $id")
            return
        }
        reclaimProfiles(id)
        val instance = Instance(id)
        if (module.discord) {
            val discord = DiscordView(instance.context, id, url, settings, object : DiscordView.Listener {
                override fun onState(state: JsonObject) {
                    if (instances[id] === instance) event("discordState", "instance" to JsonPrimitive(id), "state" to state)
                }

                override fun onNotification(notification: JsonObject) {
                    if (instances[id] === instance) event("discordNotification", "instance" to JsonPrimitive(id), "notification" to notification)
                }

                // Discord's page holds the microphone or camera: a call, which the background service keeps going.
                override fun onMedia(audio: Boolean, video: Boolean) {
                    if (instances[id] === instance) setCall(id, if (audio || video) Call(id, name, video, inChatView = false) else null)
                }
            }, ui = this, camera = ::camera)
            instance.discord = discord
            instances[id] = instance
            discord.start()
        } else if (module.web) {
            val web = WebClientView(instance.context, id, url, onTitle = { title ->
                if (instances[id] === instance) event("title", "instance" to JsonPrimitive(id), "title" to JsonPrimitive(title))
            }, ui = this)
            instance.web = web
            instances[id] = instance
            web.start()
        } else {
            val spec = EngineSpec(instanceId = id, engine = module.engine ?: return, name = name, url = url, hosts = module.hosts, settings = settings, storage = module.storage)
            val engine = EngineHost(app, spec, secrets.scope(id), instance, this)
            instance.engine = engine
            instances[id] = instance
            engine.start()
        }
        onRunningChanged?.invoke(instances.size)
        pendingOpen?.takeIf { it.instance == id }?.let { target ->
            pendingOpen = null
            main.post { openNotification(target) }
        }
        if (shown == id) place()
    }

    private fun stop(id: String) {
        val instance = instances.remove(id) ?: return
        setCall(id, null)
        instance.engine?.destroy()
        instance.view?.destroy()
        instance.web?.destroy()
        instance.discord?.destroy()
        onRunningChanged?.invoke(instances.size)
        if (shown == id) place()
    }

    /** Stops an instance and deletes its web storage: its engine's and its view's Profiles, or its web app's. */
    private fun clearSession(id: String) {
        stop(id)
        val pending = readPending()
        for (profile in profilesOf(id)) {
            if (!deleteProfile(profile)) {
                // Emptied now; the Profile itself goes at the next start.
                wipe(profile)
                pending += profile
            }
        }
        writePending(pending)
    }

    /**
     * An instance id that comes back (removed, then added again) must not find the old instance's storage,
     * nor lose its own to a deletion still waiting: whatever waits is deleted now, or emptied.
     */
    private fun reclaimProfiles(id: String) {
        val pending = readPending()
        val names = profilesOf(id).filter { it in pending }
        if (names.isEmpty()) return
        for (name in names) {
            if (!deleteProfile(name)) wipe(name)
            pending -= name
        }
        writePending(pending)
    }

    /** Every Profile an instance may have used: its engine's and chat view's, its web app's, or its Discord view's. */
    private fun profilesOf(id: String) = listOf(EngineHost.profileName(id), ChatView.profileName(id), WebClientView.profileName(id), DiscordView.profileName(id))

    private fun deleteProfile(name: String): Boolean = try {
        ProfileStore.getInstance().deleteProfile(name)
        Log.i(TAG, "Deleted Profile $name")
        true
    } catch (error: IllegalStateException) {
        // Still in use until the WebViews are gone for good: deleted at the next start.
        Log.i(TAG, "Profile $name is deleted at the next start (${error.message})")
        false
    }

    private fun wipe(name: String) {
        val profile = ProfileStore.getInstance().getOrCreateProfile(name)
        profile.webStorage.deleteAllData()
        profile.cookieManager.removeAllCookies(null)
    }

    private fun deletePendingProfiles() {
        val pending = readPending()
        if (pending.isEmpty()) return
        writePending(pending.filterNot(::deleteProfile).toMutableSet())
    }

    private fun readPending(): MutableSet<String> = try {
        (Json.parseToJsonElement(profilesToDelete.readText()) as JsonArray).map { (it as JsonPrimitive).content }.filter(PROFILE::matches).toMutableSet()
    } catch (_: Exception) {
        HashSet()
    }

    private fun writePending(names: Set<String>) {
        if (names.isEmpty()) profilesToDelete.delete() else profilesToDelete.writeText(JsonArray(names.map(::JsonPrimitive)).toString())
    }

    // Calls -----------------------------------------------------------------------------------------------

    /** An instance's call as its engine now reports it (null: none); the audio, the screen and the background service follow. */
    private fun setCall(id: String, call: Call?) {
        if (callsByInstance[id] == call) return
        if (call == null) callsByInstance.remove(id) else callsByInstance[id] = call
        Log.i(TAG, if (call == null) "[call $id] ended" else "[call $id] in progress" + (if (call.video) " with video" else ""))
        // Audio routes and the screen follow a chat view's call; a web app's (Discord's) are its page's own.
        val first = callsByInstance.values.firstOrNull { it.inChatView }
        callAudio.update(first)
        screen?.inCall(first)
        val service = onCallsChanged
        if (service != null) {
            service()
        } else if (call != null) {
            // The background service did not start before (the app was not in front then): it may now.
            try {
                app.startForegroundService(Intent(app, ConnectionService::class.java))
            } catch (error: Exception) {
                Log.w(TAG, "Could not start the background service for a call: ${error.message}")
            }
        }
    }

    /** Hang up from the call notification: each call is left, as the view's Leave does. */
    fun hangUp() {
        for (id in callsByInstance.keys.toList()) instances[id]?.engine?.action(JsonObject(mapOf("type" to JsonPrimitive("leaveVoice"))))
    }

    /**
     * A chat view asks for the camera or microphone: granted only as CallPolicy allows for that view's own
     * call, once Android's runtime permission is held (asked now if need be); the background service may then
     * take the microphone and camera types.
     */
    private fun permit(instanceId: String, request: PermissionRequest) {
        val viewOrigin = instances[instanceId]?.view?.origin
        val wanted = if (viewOrigin == null) emptyList() else CallPolicy.grantable(request.resources.toList(), request.origin?.toString(), viewOrigin, callsByInstance[instanceId])
        if (wanted.isEmpty()) {
            Log.i(TAG, "[view $instanceId] refused ${request.resources.joinToString()}: no call of its own wants it")
            return request.deny()
        }
        val needed = wanted.mapNotNull { CallPolicy.ANDROID_PERMISSIONS[it] }.distinct()
        val asked = requestPermissions(needed) { granted ->
            val ok = wanted.filter { CallPolicy.ANDROID_PERMISSIONS[it] in granted }
            if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
            onCallsChanged?.invoke()
        }
        if (!asked) request.deny()
    }

    // Views -----------------------------------------------------------------------------------------------

    /** The shown instance's chat view, made when first shown; at most MAX_VIEWS are kept, the least recently shown go. */
    private fun viewOf(instance: Instance): ChatView? {
        val engine = instance.engine ?: return null
        instance.shownAt = ++shows
        instance.view?.let { return it }
        val view = ChatView(
            instance.context,
            instance.id,
            onAction = { action ->
                // Checked, then to this view's engine only.
                if (Validators.isNativeAction(action)) engine.action(action as JsonObject)
                else Log.w(TAG, "[view ${instance.id}] dropped a malformed action")
            },
            onBack = ::onBackAnswer,
            viewHosts = { engine.allowedHosts },
            onPermission = { request -> permit(instance.id, request) },
            // Only the view of the call that has the phone's audio picks its route.
            onRoute = { route -> if (callsByInstance.values.firstOrNull { it.inChatView }?.instance == instance.id) callAudio.choose(route) },
            camera = ::camera,
        )
        view.start()
        view.theme(theme)
        instance.media?.let(view::mediaAutoLoad)
        view.usbCamera(instance.usbCamera)
        instance.state?.let(view::showState)
        instance.view = view
        val kept = instances.values.filter { it.view != null }.sortedByDescending { it.shownAt }
        // A view in a call runs that call: it stays.
        for (old in kept.drop(MAX_VIEWS).filter { it.id !in callsByInstance }) {
            old.view?.destroy()
            old.view = null
        }
        return view
    }

    private var shows = 0L

    private fun place() {
        val screen = screen ?: return
        val instance = shown?.let { instances[it] }
        val view = instance?.web?.webView ?: instance?.discord?.webView ?: instance?.let(::viewOf)?.webView
        screen.place(shell?.webView, view, instance == null || overlay)
    }

    // What engines may ask of the screen ------------------------------------------------------------------

    override fun pickDocuments(done: (List<String>) -> Unit): Boolean = screen?.pickDocuments(done) ?: false

    override fun openBrowser(url: String): Boolean = screen?.openBrowser(url) ?: false

    // What web apps may ask of the screen: uploads (pickDocuments, above), and camera and microphone (WebClientPolicy decides which).

    override fun requestPermissions(permissions: List<String>, done: (Set<String>) -> Unit): Boolean = screen?.requestPermissions(permissions, done) ?: false

    companion object {
        private const val TAG = "Multicord"
        /** Chat views kept alive at once; others are made again when shown. */
        private const val MAX_VIEWS = 3
        private const val BACK_WAIT_MS = 400L
        private val PROFILE = Regex("^(engine|view|web|discord)-[a-z0-9][a-z0-9-]{0,31}$")
    }
}
