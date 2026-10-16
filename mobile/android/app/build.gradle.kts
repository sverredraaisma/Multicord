// Multicord for Android. Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
import com.android.build.api.variant.HostTestBuilder

plugins {
    id("com.android.application")
}

/** The repository root: the desktop app's sources, tests and build output live there. */
val repoRoot: File = rootProject.projectDir.resolve("../..").canonicalFile

/**
 * Release signing, never in the repository: a Gradle property (-P or ~/.gradle/gradle.properties) or an
 * environment variable, e.g. multicord.keystore or MULTICORD_KEYSTORE. Without a keystore the release
 * APK is built unsigned (app-release-unsigned.apk), as F-Droid builds it before signing with its own key.
 */
fun secret(property: String, variable: String): String? =
    providers.gradleProperty(property).orElse(providers.environmentVariable(variable)).orNull?.takeIf { it.isNotBlank() }

val releaseKeystore = secret("multicord.keystore", "MULTICORD_KEYSTORE")

android {
    namespace = "app.multicord"
    compileSdk = 36
    // The USB camera's native code (libusb, libuvc, the JNI layer in src/main/cpp). CI installs this NDK if it is missing.
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "app.multicord"
        // API 28: the lowest the spike was checked on; Profiles need a recent WebView, checked at start.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-dev"
        ndk {
            // Phones, and the x86_64 emulator.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = secret("multicord.keystorePassword", "MULTICORD_KEYSTORE_PASSWORD")
                keyAlias = secret("multicord.keyAlias", "MULTICORD_KEY_ALIAS")
                keyPassword = secret("multicord.keyPassword", "MULTICORD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            // R8: shrinks and obfuscates our code and the libraries'; keep rules in proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    // No Google-encrypted dependency list in the APK's signing block: F-Droid cannot read it and asks for it to be off.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    // lintDebug runs in CI (the android job): any error or warning fails it, so it stays clean.
    lint {
        abortOnError = true
        warningsAsErrors = true
        checkDependencies = false
        // Which newer versions exist (asked over the network, so a run could pass today and fail tomorrow):
        // upgrades of the SDK and libraries are deliberate changes of their own, not lint's.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "OldTargetApi", "AndroidGradlePluginVersion")
        // Only androidx.webkit's own checks, which cannot see what the app does about them (lint-baseline.xml):
        // - RequiresFeature: MULTI_PROFILE, DOCUMENT_START_SCRIPT and WEB_MESSAGE_LISTENER are checked once at
        //   start (WebViewSupport.REQUIRED_FEATURES); without them nothing starts, so no call site runs unchecked.
        // - MissingOnRenderProcessGone: each WebViewClient does implement onRenderProcessGone (restart or reload);
        //   the check misses it on these Kotlin inner classes.
        // Anything new still fails: the baseline names each file and message.
        baseline = file("lint-baseline.xml")
    }
}

/**
 * The shared test cases (tests/fixtures: the network policy's, the validators', the shell bridge's and Discord's), copied from the repository
 * root at build time so the Kotlin tests run the very files the TypeScript tests run.
 */
abstract class CopyFixtures : DefaultTask() {
    @get:InputFiles
    abstract val fixtures: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = outputDir.get().asFile.resolve("fixtures")
        dir.deleteRecursively()
        dir.mkdirs()
        for (file in fixtures.files) {
            if (!file.isFile) throw GradleException("Missing test fixture $file")
            file.copyTo(dir.resolve(file.name), overwrite = true)
        }
    }
}

val copyFixtures = tasks.register<CopyFixtures>("copyFixtures") {
    fixtures.from(
        repoRoot.resolve("tests/fixtures/netpolicy-cases.json"),
        repoRoot.resolve("tests/fixtures/engine-validator-cases.json"),
        repoRoot.resolve("tests/fixtures/shell-bridge-cases.json"),
        repoRoot.resolve("tests/fixtures/discord-bridge-cases.json"),
    )
    outputDir.set(layout.buildDirectory.dir("generated/fixtures"))
}

/**
 * The desktop build's bundles the app runs (`npm run build` at the repo root makes them in dist/): each
 * module engine (dist/engines/<id>.js, served on the engine's own origin), the native chat view with what it
 * loads (served on each instance's view origin), and the shell page with core (dist/mobile: shell.html,
 * shell.js, mobile.css, and modules.json, the table of engines, hosts and storage native code reads).
 * Source maps stay out. The task fails, naming the command, when dist/ has not been built.
 */
abstract class BundleWeb : DefaultTask() {
    @get:InputFiles
    abstract val engines: ConfigurableFileCollection

    @get:InputFiles
    abstract val shell: ConfigurableFileCollection

    @get:InputFiles
    abstract val mobile: ConfigurableFileCollection

    @get:Internal
    abstract val dist: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun bundle() {
        val root = dist.get().asFile
        val missing = (engines.files + shell.files + mobile.files).filter { !it.isFile }
        if (engines.isEmpty || missing.isNotEmpty()) {
            throw GradleException("The desktop bundles are missing (${missing.joinToString { it.relativeTo(root).path }}). Run `npm ci && npm run build` at the repository root first.")
        }
        val web = outputDir.get().asFile.resolve("web")
        web.deleteRecursively()
        for (file in engines.files) file.copyTo(web.resolve("engines/${file.name}"), overwrite = true)
        for (file in shell.files) file.copyTo(web.resolve("shell/${file.relativeTo(root).invariantSeparatorsPath}"), overwrite = true)
        for (file in mobile.files) file.copyTo(web.resolve("mobile/${file.name}"), overwrite = true)
    }
}

val bundleWeb = tasks.register<BundleWeb>("bundleWeb") {
    val distDir = repoRoot.resolve("dist")
    dist.set(distDir)
    // Every native module's engine (the module table names them all).
    engines.from(listOf("matrix", "fluxer", "telegram", "stoat", "spacebar", "nerimity").map { distDir.resolve("engines/$it.js") })
    shell.from(
        listOf(
            "native.html", "native.js", "native.css", "shell.css", "settings.css", "messages.css", "audio/rnnoise-worklet.js", "livekit-e2ee-worker.js",
            "mobile/shell.html", "mobile/shell.js", "mobile/mobile.css",
        ).map { distDir.resolve(it) },
    )
    // The module table, and the Discord view's document-start scripts (src/mobile/discordView.ts), in web/mobile.
    mobile.from(listOf("modules.json", "discord-page.js", "discord-relay.js").map { distDir.resolve("mobile/$it") })
    outputDir.set(layout.buildDirectory.dir("generated/web"))
}

androidComponents {
    onVariants { variant ->
        variant.hostTests[HostTestBuilder.UNIT_TEST_TYPE]?.sources?.resources?.addGeneratedSourceDirectory(copyFixtures, CopyFixtures::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(bundleWeb, BundleWeb::outputDir)
    }
}

dependencies {
    // Profiles, document-start scripts and origin-restricted message listeners.
    implementation("androidx.webkit:webkit:1.17.1")
    // Single sign-on in a Custom Tab (the user's browser, over the app).
    implementation("androidx.browser:browser:1.8.0")
    // JSON for the bridge's messages and validators (no compiler plugin: only the JsonElement tree is used).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    // The engines' HTTP and WebSockets: a DNS hook for the address check, no cookies, no cache.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
}
