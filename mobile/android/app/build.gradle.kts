// Multicord for Android. Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
import com.android.build.api.variant.HostTestBuilder

plugins {
    id("com.android.application")
}

/** The repository root: the desktop app's sources, tests and build output live there. */
val repoRoot: File = rootProject.projectDir.resolve("../..").canonicalFile

android {
    namespace = "app.multicord"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.multicord"
        // API 28: the lowest the spike was checked on; Profiles need a recent WebView, checked at start.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-dev"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

/**
 * The network policy's shared test cases (tests/fixtures/netpolicy-cases.json), copied from the repository
 * root at build time so the Kotlin tests run the very file the TypeScript tests run.
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
    fixtures.from(repoRoot.resolve("tests/fixtures/netpolicy-cases.json"))
    outputDir.set(layout.buildDirectory.dir("generated/fixtures"))
}

/**
 * The desktop build's bundles the app runs (`npm run build` at the repo root makes them in dist/): each
 * module engine (dist/engines/<id>.js, served on the engine's own origin) and the native chat view with
 * what it loads (served on the shell's origin). Source maps stay out. The task fails, naming the command,
 * when dist/ has not been built.
 */
abstract class BundleWeb : DefaultTask() {
    @get:InputFiles
    abstract val engines: ConfigurableFileCollection

    @get:InputFiles
    abstract val shell: ConfigurableFileCollection

    @get:Internal
    abstract val dist: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun bundle() {
        val root = dist.get().asFile
        val missing = (engines.files + shell.files).filter { !it.isFile }
        if (engines.isEmpty || missing.isNotEmpty()) {
            throw GradleException("The desktop bundles are missing (${missing.joinToString { it.relativeTo(root).path }}). Run `npm ci && npm run build` at the repository root first.")
        }
        val web = outputDir.get().asFile.resolve("web")
        web.deleteRecursively()
        for (file in engines.files) file.copyTo(web.resolve("engines/${file.name}"), overwrite = true)
        for (file in shell.files) file.copyTo(web.resolve("shell/${file.relativeTo(root).invariantSeparatorsPath}"), overwrite = true)
    }
}

val bundleWeb = tasks.register<BundleWeb>("bundleWeb") {
    val distDir = repoRoot.resolve("dist")
    dist.set(distDir)
    // Matrix first; the other engines follow once their hosts' needs are met (mobile/android/README.md).
    engines.from(distDir.resolve("engines/matrix.js"))
    // The shell's pages come with the shell.
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
    // JSON for the bridge's messages and validators (no compiler plugin: only the JsonElement tree is used).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    // The engines' HTTP and WebSockets: a DNS hook for the address check, no cookies, no cache.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
}
